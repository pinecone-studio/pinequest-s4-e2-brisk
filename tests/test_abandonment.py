import unittest

from app.abandonment import AbandonmentMachine, AbanState, LitteringEvent
from app.association import ObjectState


def _obj_det(track_id, cx, cy, margin=10):
    """Non-person detection centered at (cx, cy)."""
    return {
        "class": "bottle",
        "track_id": track_id,
        "bbox": (cx - margin, cy - margin, cx + margin, cy + margin),
    }


def _person_det(track_id, x1, y1, x2, y2):
    return {"class": "person", "track_id": track_id, "bbox": (x1, y1, x2, y2)}


def _make_state(owner_id=None, is_carried=False, dropped_at=None, drop_location=None):
    s = ObjectState()
    s.owner_id = owner_id
    s.is_carried = is_carried
    s.dropped_at = dropped_at
    s.drop_location = drop_location
    return s


def _fast_machine():
    """Machine with 1-second timers so tests don't need long sleeps."""
    return AbandonmentMachine(
        t_stationary=1.0,
        t_departure=1.0,
        movement_px=15,
        t_disappear=2.0,
    )


class AbandonmentMachineFullPipelineTest(unittest.TestCase):
    def test_idle_to_alerted_emits_littering_event(self):
        """Happy path: IDLE → CARRIED → DROPPED → STATIONARY → OWNER_DEPARTED → ALERTED."""
        machine = _fast_machine()
        dets = [_obj_det(10, 100, 200)]
        assoc = {10: _make_state(owner_id=1)}

        # IDLE → CARRIED: owner seen for first time
        machine.update(0.0, dets, assoc)
        self.assertEqual(machine.get_state(10), AbanState.CARRIED)

        # CARRIED → DROPPED: associator records separation
        assoc[10].dropped_at = 1
        assoc[10].drop_location = (100, 200)
        machine.update(1.0, dets, assoc)
        self.assertEqual(machine.get_state(10), AbanState.DROPPED)

        # DROPPED → STATIONARY: t_stationary elapsed without movement
        machine.update(2.0, dets, assoc)
        self.assertEqual(machine.get_state(10), AbanState.STATIONARY)

        # STATIONARY: owner absent — start departure clock
        machine.update(2.5, dets, assoc)  # no person in dets → absent
        self.assertEqual(machine.get_state(10), AbanState.STATIONARY)

        # STATIONARY → OWNER_DEPARTED: t_departure elapsed
        machine.update(3.5, dets, assoc)
        self.assertEqual(machine.get_state(10), AbanState.OWNER_DEPARTED)

        # OWNER_DEPARTED → ALERTED: event fires
        events = machine.update(4.0, dets, assoc)
        self.assertEqual(machine.get_state(10), AbanState.ALERTED)
        self.assertEqual(len(events), 1)
        evt = events[0]
        self.assertIsInstance(evt, LitteringEvent)
        self.assertEqual(evt.object_id, 10)
        self.assertEqual(evt.owner_id, 1)

    def test_alerted_does_not_refire(self):
        machine = _fast_machine()
        dets = [_obj_det(10, 100, 200)]
        assoc = {10: _make_state(owner_id=1)}
        machine.update(0.0, dets, assoc)
        assoc[10].dropped_at = 1
        assoc[10].drop_location = (100, 200)
        machine.update(1.0, dets, assoc)
        machine.update(2.0, dets, assoc)
        machine.update(2.5, dets, assoc)
        machine.update(3.5, dets, assoc)
        first = machine.update(4.0, dets, assoc)
        self.assertEqual(len(first), 1)

        for t_int in range(5, 10):
            events = machine.update(float(t_int), dets, assoc)
            self.assertEqual(events, [], f"unexpected re-fire at t={t_int}")


class AbandonmentMachineGuardTest(unittest.TestCase):
    def test_unowned_object_never_alerts(self):
        machine = _fast_machine()
        dets = [_obj_det(10, 100, 200)]
        assoc = {10: _make_state()}  # owner_id=None
        for t in range(20):
            events = machine.update(float(t), dets, assoc)
            self.assertEqual(events, [])

    def test_repickup_resets_to_carried(self):
        machine = _fast_machine()
        dets = [_obj_det(10, 100, 200)]
        assoc = {10: _make_state(owner_id=1)}
        machine.update(0.0, dets, assoc)               # → CARRIED
        assoc[10].dropped_at = 1
        assoc[10].drop_location = (100, 200)
        machine.update(1.0, dets, assoc)               # → DROPPED
        self.assertEqual(machine.get_state(10), AbanState.DROPPED)

        assoc[10].is_carried = True
        assoc[10].dropped_at = None
        assoc[10].drop_location = None
        events = machine.update(1.5, dets, assoc)
        self.assertEqual(machine.get_state(10), AbanState.CARRIED)
        self.assertEqual(events, [])

    def test_owner_present_in_stationary_resets_departure_clock(self):
        machine = _fast_machine()
        dets_no_person = [_obj_det(10, 100, 200)]
        assoc = {10: _make_state(owner_id=1)}
        machine.update(0.0, dets_no_person, assoc)
        assoc[10].dropped_at = 1
        assoc[10].drop_location = (100, 200)
        machine.update(1.0, dets_no_person, assoc)  # → DROPPED
        machine.update(2.0, dets_no_person, assoc)  # → STATIONARY
        machine.update(2.5, dets_no_person, assoc)  # absence clock starts at 2.5

        # Owner reappears — clock should reset
        dets_with_owner = [_obj_det(10, 100, 200), _person_det(1, 0, 0, 200, 400)]
        machine.update(3.0, dets_with_owner, assoc)
        self.assertEqual(machine.get_state(10), AbanState.STATIONARY)

        # Even though 1 s has passed since 2.5, the clock was reset at 3.0
        machine.update(3.4, dets_no_person, assoc)  # owner gone again, only 0.4 s
        self.assertEqual(machine.get_state(10), AbanState.STATIONARY)


class AbandonmentMachineTimerTest(unittest.TestCase):
    def test_movement_resets_stationary_timer(self):
        machine = _fast_machine()
        assoc = {10: _make_state(owner_id=1)}
        machine.update(0.0, [_obj_det(10, 100, 200)], assoc)   # → CARRIED
        assoc[10].dropped_at = 1
        assoc[10].drop_location = (100, 200)
        machine.update(1.0, [_obj_det(10, 100, 200)], assoc)   # → DROPPED (stationary_since=1.0)
        # Object moves > movement_px=15 at t=1.8 → timer resets to 1.8
        machine.update(1.8, [_obj_det(10, 130, 200)], assoc)
        # t=2.0 is only 0.2 s after the reset, not enough for t_stationary=1.0
        machine.update(2.0, [_obj_det(10, 130, 200)], assoc)
        self.assertEqual(machine.get_state(10), AbanState.DROPPED)

    def test_brief_disappear_does_not_reset_dropped_state(self):
        machine = _fast_machine()
        assoc = {10: _make_state(owner_id=1)}
        machine.update(0.0, [_obj_det(10, 100, 200)], assoc)
        assoc[10].dropped_at = 1
        assoc[10].drop_location = (100, 200)
        machine.update(1.0, [_obj_det(10, 100, 200)], assoc)   # → DROPPED (stationary_since=1.0)
        # Object absent for 0.5 s < t_disappear=2.0 — state should survive
        machine.update(1.5, [], assoc)
        self.assertEqual(machine.get_state(10), AbanState.DROPPED)
        # Object reappears; stationary timer kept running from 1.0, so 2.0-1.0=1.0 → STATIONARY
        machine.update(2.0, [_obj_det(10, 100, 200)], assoc)
        self.assertEqual(machine.get_state(10), AbanState.STATIONARY)

    def test_long_disappear_resets_to_idle(self):
        machine = _fast_machine()
        assoc = {10: _make_state(owner_id=1)}
        machine.update(0.0, [_obj_det(10, 100, 200)], assoc)
        assoc[10].dropped_at = 1
        assoc[10].drop_location = (100, 200)
        machine.update(1.0, [_obj_det(10, 100, 200)], assoc)   # DROPPED (last_seen=1.0)
        machine.update(1.5, [], assoc)                          # gap=0.5 — still DROPPED
        self.assertEqual(machine.get_state(10), AbanState.DROPPED)
        machine.update(4.0, [], assoc)                          # gap=3.0 > t_disappear=2.0 → IDLE
        self.assertEqual(machine.get_state(10), AbanState.IDLE)


class AbandonmentMachineReownTest(unittest.TestCase):
    def test_reown_map_migrates_track_state(self):
        """State (including stationary timer) survives a ByteTrack ID change via reown_map."""
        machine = _fast_machine()
        assoc = {10: _make_state(owner_id=1)}
        machine.update(0.0, [_obj_det(10, 100, 200)], assoc)   # → CARRIED
        assoc[10].dropped_at = 1
        assoc[10].drop_location = (100, 200)
        machine.update(1.0, [_obj_det(10, 100, 200)], assoc)   # → DROPPED
        self.assertEqual(machine.get_state(10), AbanState.DROPPED)

        # Track ID changes from 10 → 20; associator provides reown_map
        new_assoc = {20: _make_state(owner_id=1, dropped_at=1, drop_location=(100, 200))}
        machine.update(1.5, [_obj_det(20, 102, 202)], new_assoc, reown_map={20: 10})

        self.assertIsNone(machine.get_state(10), "old track ID should be gone")
        self.assertEqual(machine.get_state(20), AbanState.DROPPED, "state migrated to new ID")


if __name__ == "__main__":
    unittest.main()

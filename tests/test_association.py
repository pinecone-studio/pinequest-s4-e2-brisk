import unittest

from app.association import Associator, CARRY_FRAMES, HYSTERESIS_FRAMES, REOWN_RADIUS_PX


def _person(track_id, x1, y1, x2, y2):
    return {"class": "person", "track_id": track_id, "bbox": (x1, y1, x2, y2)}


def _obj(track_id, cx, cy, margin=10, cls="bottle"):
    return {
        "class": cls,
        "track_id": track_id,
        "bbox": (cx - margin, cy - margin, cx + margin, cy + margin),
    }


class AssociatorOwnershipTest(unittest.TestCase):
    def test_ownership_confirmed_after_carry_frames(self):
        assoc = Associator(carry_frames=3, hysteresis_frames=10)
        person = _person(1, 0, 0, 200, 400)
        obj = _obj(10, 100, 200)  # center inside person bbox
        for i in range(3):
            assoc.update(i, [person, obj])
        state = assoc.object_states[10]
        self.assertTrue(state.is_carried)
        self.assertEqual(state.owner_id, 1)

    def test_partial_overlap_does_not_confirm_ownership(self):
        assoc = Associator(carry_frames=5, hysteresis_frames=10)
        person = _person(1, 0, 0, 200, 400)
        obj = _obj(10, 100, 200)
        for i in range(4):  # one short of carry_frames
            assoc.update(i, [person, obj])
        self.assertFalse(assoc.object_states[10].is_carried)

    def test_hysteresis_delays_separation(self):
        assoc = Associator(carry_frames=2, hysteresis_frames=5)
        person = _person(1, 0, 0, 200, 400)
        obj = _obj(10, 100, 200)
        for i in range(2):
            assoc.update(i, [person, obj])
        self.assertTrue(assoc.object_states[10].is_carried)

        # Remove person: hysteresis=5, frames 2-4 still inside grace window
        for i in range(2, 5):
            assoc.update(i, [obj])
        self.assertTrue(assoc.object_states[10].is_carried, "still within hysteresis")

        # Exhaust remaining hysteresis (frames 5-6)
        for i in range(5, 7):
            assoc.update(i, [obj])
        self.assertFalse(assoc.object_states[10].is_carried, "separated after hysteresis")

    def test_separation_records_drop_info(self):
        assoc = Associator(carry_frames=2, hysteresis_frames=1)
        person = _person(1, 0, 0, 200, 400)
        obj = _obj(10, 100, 200)
        for i in range(2):
            assoc.update(i, [person, obj])
        # One frame without person exhausts hysteresis=1
        assoc.update(2, [obj])
        state = assoc.object_states[10]
        self.assertFalse(state.is_carried)
        self.assertIsNotNone(state.dropped_at)
        self.assertIsNotNone(state.drop_location)

    def test_repickup_clears_drop_record(self):
        assoc = Associator(carry_frames=2, hysteresis_frames=1)
        person = _person(1, 0, 0, 200, 400)
        obj = _obj(10, 100, 200)
        for i in range(2):
            assoc.update(i, [person, obj])
        assoc.update(2, [obj])  # drop
        self.assertIsNotNone(assoc.object_states[10].dropped_at)
        # Re-acquire
        for i in range(3, 5):
            assoc.update(i, [person, obj])
        state = assoc.object_states[10]
        self.assertTrue(state.is_carried)
        self.assertIsNone(state.dropped_at)
        self.assertIsNone(state.drop_location)

    def test_unowned_object_stays_unowned(self):
        assoc = Associator()
        obj = _obj(10, 500, 500)  # far from any person
        for i in range(10):
            assoc.update(i, [obj])
        state = assoc.object_states[10]
        self.assertIsNone(state.owner_id)
        self.assertFalse(state.is_carried)


class AssociatorGhostReownTest(unittest.TestCase):
    def test_ghost_reown_inherits_owner(self):
        assoc = Associator(carry_frames=2, hysteresis_frames=1)
        person = _person(1, 0, 0, 200, 400)
        obj = _obj(10, 100, 200)
        for i in range(2):
            assoc.update(i, [person, obj])
        # Track 10 disappears — ghost is created
        assoc.update(2, [person])
        # New track 20 appears close to the ghost position
        new_obj = _obj(20, 102, 202)
        assoc.update(3, [person, new_obj])
        state = assoc.object_states.get(20)
        self.assertIsNotNone(state, "new track should exist in object_states")
        self.assertEqual(state.owner_id, 1, "should inherit owner from ghost")
        self.assertIn(20, assoc.reown_map)
        self.assertEqual(assoc.reown_map[20], 10)

    def test_ghost_reown_landing_becomes_drop_location(self):
        """Track that vanished while still carried: landing point becomes drop_location."""
        assoc = Associator(carry_frames=2, hysteresis_frames=1)
        person = _person(1, 0, 0, 200, 400)
        obj = _obj(10, 100, 200)
        for i in range(2):
            assoc.update(i, [person, obj])
        assoc.update(2, [person])  # track 10 gone while still carried → ghost
        new_obj = _obj(20, 102, 202)
        assoc.update(3, [person, new_obj])
        state = assoc.object_states[20]
        # Landing location should be recorded as the drop point
        self.assertIsNotNone(state.drop_location)
        self.assertIsNotNone(state.dropped_at)
        self.assertFalse(state.is_carried)

    def test_ghost_not_matched_outside_radius(self):
        assoc = Associator(carry_frames=2, hysteresis_frames=1)
        person = _person(1, 0, 0, 200, 400)
        obj = _obj(10, 100, 200)
        for i in range(2):
            assoc.update(i, [person, obj])
        assoc.update(2, [person])  # ghost near (100, 200)
        # New track > REOWN_RADIUS_PX away
        far_obj = _obj(20, 600, 600)
        assoc.update(3, [person, far_obj])
        state = assoc.object_states.get(20)
        self.assertIsNotNone(state)
        self.assertIsNone(state.owner_id, "far track should not inherit from ghost")

    def test_reown_map_is_cleared_each_frame(self):
        assoc = Associator(carry_frames=2, hysteresis_frames=1)
        person = _person(1, 0, 0, 200, 400)
        obj = _obj(10, 100, 200)
        for i in range(2):
            assoc.update(i, [person, obj])
        assoc.update(2, [person])  # ghost created
        new_obj = _obj(20, 102, 202)
        assoc.update(3, [person, new_obj])
        self.assertIn(20, assoc.reown_map)
        # Next frame: reown_map should be cleared
        assoc.update(4, [person, new_obj])
        self.assertNotIn(20, assoc.reown_map)


if __name__ == "__main__":
    unittest.main()

import Link from "next/link";

export default function HomePage() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: 16,
        color: "var(--muted)",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <p style={{ fontSize: 18, color: "var(--text)" }}>Demo page coming soon</p>
      <Link href="/cameras" style={{ fontSize: 13, color: "var(--accent)" }}>
        View all cameras &rarr;
      </Link>
    </div>
  );
}

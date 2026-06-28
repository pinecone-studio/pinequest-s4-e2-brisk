import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aegis",
  description: "Apartment Building Surveillance",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-screen h-full bg-[#0a0a0a] text-[#e8e8e8] text-[14px] antialiased [font-family:'Segoe_UI',system-ui,-apple-system,sans-serif]">
        {children}
      </body>
    </html>
  );
}

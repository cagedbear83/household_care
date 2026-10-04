import { Platform } from "react-native";

/**
 * Opens the system print window for a page of HTML, where "Save as PDF" is one
 * of the choices. Nothing is written to a file by the app.
 */
export async function printHtml(html: string): Promise<void> {
  if (Platform.OS === "web") {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) {
      frame.remove();
      throw new Error("Could not open the print window.");
    }
    doc.open();
    doc.write(html);
    doc.close();
    // Give the page a moment to lay out, then print, and clean up afterwards.
    await new Promise((resolve) => setTimeout(resolve, 250));
    win.focus();
    win.print();
    setTimeout(() => frame.remove(), 60_000);
    return;
  }
  const Print = await import("expo-print");
  await Print.printAsync({ html });
}

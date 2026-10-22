import { usePages } from "../store/pages";
import { pageHtml } from "./markdown";
import { displayTitle } from "./text";

/**
 * Page menu > Export as PDF. Lays the page out for print (styles under #print-root in
 * index.css) and opens the print dialog, where "Save as PDF" saves it. The browser does the
 * typesetting, so the text stays selectable and every script and emoji looks as on screen.
 */
export async function exportPdf(id: string) {
  const page = usePages.getState().pages[id];
  if (!page) return;

  // The empty header and footer rows repeat on every printed page, so each page gets its top and
  // bottom margin even when the print dialog is set to no margins.
  const root = document.createElement("div");
  root.id = "print-root";
  root.innerHTML =
    '<table class="print-sheet"><thead><tr><td class="print-gap"></td></tr></thead>' +
    '<tfoot><tr><td class="print-gap"></td></tr></tfoot>' +
    '<tbody><tr><td><article class="print-body"></article></td></tr></tbody></table>';
  const body = root.querySelector(".print-body")!;
  const title = document.createElement("h1");
  title.className = "print-title";
  title.textContent = `${page.icon ? `${page.icon} ` : ""}${displayTitle(page.title)}`;
  body.append(title);
  body.insertAdjacentHTML("beforeend", await pageHtml(id));
  document.getElementById("print-root")?.remove();
  document.body.append(root);
  await imagesLoaded(root);

  // The saved file is named after the document title.
  const appTitle = document.title;
  document.title = displayTitle(page.title);
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    root.remove();
    document.title = appTitle;
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
  // Every browser fires afterprint when the dialog closes; this is only a fallback.
  setTimeout(cleanup, 60_000);
}

/** Images still loading would print blank, so wait for them: at most 10 seconds. */
function imagesLoaded(root: HTMLElement) {
  const waits = [...root.querySelectorAll("img")].map((img) => {
    img.loading = "eager"; // lazy images never load while the print view is hidden
    if (img.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      img.addEventListener("load", () => resolve(), { once: true });
      img.addEventListener("error", () => resolve(), { once: true });
    });
  });
  return Promise.race([Promise.all(waits), new Promise((resolve) => setTimeout(resolve, 10_000))]);
}

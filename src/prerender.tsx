// The public pages as HTML, for the build to put into the files it serves (see vite.config.ts):
// search engines, link previews and first visits see them before the app has loaded.
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { Landing } from "./pages/Landing";
import { Privacy } from "./pages/Privacy";
import { Agents } from "./pages/Agents";

const pages = { "/": () => <Landing onStart={() => {}} />, "/privacy": Privacy, "/agents": Agents };

export function render(path: keyof typeof pages): string {
  const Page = pages[path];
  return renderToString(
    <StaticRouter location={path}>
      <Page />
    </StaticRouter>,
  );
}

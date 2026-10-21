import { createReactInlineContentSpec } from "@blocknote/react";
import { FileText } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { isTrashed, usePages } from "../store/pages";
import { displayTitle } from "../lib/text";

/**
 * A link to another page, stored by id. It always shows the page's current title and icon,
 * so renaming a page updates every link to it.
 */
export const pageLinkSpec = createReactInlineContentSpec(
  {
    type: "pageLink",
    propSchema: { pageId: { default: "" } },
    content: "none",
  },
  {
    render: ({ inlineContent }) => <PageLinkChip id={inlineContent.props.pageId} />,
  },
);

function PageLinkChip({ id }: { id: string }) {
  const page = usePages((s) => s.pages[id]);
  const trashed = usePages((s) => isTrashed(s.pages, id));
  const navigate = useNavigate();

  if (!page) return <span className="page-link page-link-missing">Deleted page</span>;

  return (
    <a
      href={`/p/${id}`}
      className={`page-link${trashed ? " page-link-missing" : ""}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let the browser open a new tab
        e.preventDefault();
        navigate(`/p/${id}`);
      }}
    >
      <span className="page-link-icon">
        {page.icon || <FileText size="0.95em" strokeWidth={1.75} />}
      </span>
      {displayTitle(page.title)}
    </a>
  );
}

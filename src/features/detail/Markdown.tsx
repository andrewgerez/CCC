import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Agent output is untrusted: no raw HTML (react-markdown escapes it by default), links open nowhere. */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md selectable text-[13px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => <span className="text-cyan underline decoration-dotted" title={href}>{children}</span>,
          img: ({ alt }) => <span className="text-muted">[imagem: {alt}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
export default Markdown;

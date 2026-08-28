/**
 * CODB Document Model — the universal intermediate representation.
 *
 * Any input (DOCX, XLSX, PPTX, PDF, HTML, images) is parsed into this model,
 * then rendered to any output. This is the single source of truth that lets
 * one parser feed many renderers.
 */

export type CODBNodeType =
  | "document"
  | "page"
  | "paragraph"
  | "text"
  | "heading"
  | "image"
  | "table"
  | "tableRow"
  | "tableCell"
  | "list"
  | "listItem"
  | "link"
  | "pageBreak"
  | "section";

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  backgroundColor?: string;
  alignment?: "left" | "center" | "right" | "justify";
  verticalAlign?: "top" | "middle" | "bottom";
  lineHeight?: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CODBImage {
  /** Data URL / blob key / url for the raster source. */
  src?: string;
  bbox?: BoundingBox;
  description?: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface CODBLink {
  href?: string;
  text?: string;
}

export interface CODBContentBlock {
  type: "text" | "image" | "link" | "table" | "list";
  text?: string;
  image?: CODBImage;
  link?: CODBLink;
  style?: TextStyle;
}

export interface CODBPage {
  /** 1-indexed page number. */
  page: number;
  width?: number;
  height?: number;
  blocks: CODBContentBlock[];
}

export interface CODBDocument {
  /** Original source: "application/pdf", "text/plain", etc. */
  sourceType?: string;
  title?: string;
  language?: string;
  pages: CODBPage[];
  images: CODBImage[];
  tables: unknown[];
  links: CODBLink[];
  headings: CODBContentBlock[];
  /** Free-form metadata attached by parsers/processors. */
  metadata: Record<string, unknown>;
}

export function createDocument(init?: Partial<CODBDocument>): CODBDocument {
  return {
    pages: init?.pages ?? [],
    images: init?.images ?? [],
    tables: init?.tables ?? [],
    links: init?.links ?? [],
    headings: init?.headings ?? [],
    metadata: init?.metadata ?? {},
    ...init,
  };
}

/** Flatten all text content across the document (for RAG / embeddings). */
export function documentToText(doc: CODBDocument): string {
  const out: string[] = [];
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.type === "text" && block.text) out.push(block.text);
      if (block.type === "link" && block.link?.text) out.push(block.link.text);
    }
  }
  return out.join("\n");
}

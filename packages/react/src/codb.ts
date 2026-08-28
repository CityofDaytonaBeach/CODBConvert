/**
 * Wires every @codb package converter into the shared registry and exposes a
 * ready-to-use CODBDocs singleton — the universal API described in start.md.
 */

import { CODBDocs, checkCapabilities } from "@codb/core";
import { register as registerPdf } from "@codb/pdf";
import { register as registerImage } from "@codb/image";
import { register as registerOffice } from "@codb/office";

registerPdf();
registerImage();
registerOffice();

export const report = checkCapabilities();
export const codb = new CODBDocs(report);

export type { CODBConvertOptions, CODBOutput } from "@codb/core";

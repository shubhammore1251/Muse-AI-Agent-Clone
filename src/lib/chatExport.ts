import type { ChatMessage } from "@/types";
import {
    AlignmentType,
    Document,
    ExternalHyperlink,
    HeadingLevel,
    LevelFormat,
    Packer,
    Paragraph,
    TextRun,
} from "docx";
import * as FileSystem from "expo-file-system/legacy";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Marked } from "marked";
import { Platform } from "react-native";

export type ChatExportFormat = "pdf" | "docx";
export type ChatExportDestination = "share" | "download";

type MarkdownToken = {
  type: string;
  text?: string;
  raw?: string;
  href?: string;
  depth?: number;
  lang?: string;
  ordered?: boolean;
  start?: number;
  items?: MarkdownToken[];
  tokens?: MarkdownToken[];
  header?: MarkdownToken[];
  rows?: MarkdownToken[][];
};

type RunStyle = {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });

const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

function safeFilename(value: string) {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || "muse-ai-chat";
}

function createExportFilename(title: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${safeFilename(title)}-${timestamp}`;
}

function isSupportedLink(href: string) {
  try {
    const protocol = new URL(href).protocol;
    return (
      protocol === "http:" || protocol === "https:" || protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

function renderPdfHtml(messages: ChatMessage[], title: string) {
  const messageHtml = messages
    .filter((message) => message.text.trim())
    .map((message) => {
      const role =
        message.sender === "user"
          ? "You"
          : message.sender === "system"
            ? "System"
            : "Muse AI";
      const body = markdown.parse(message.text, { async: false });
      return `<article class="message"><header><strong>${role}</strong><time>${escapeHtml(message.timestamp)}</time></header><section>${body}</section></article>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 20mm 18mm; }
    body { color: #202124; font: 11pt/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    h1 { font-size: 22pt; margin: 0 0 22pt; }
    .message { border-bottom: 1px solid #dfe3e8; padding: 0 0 12pt; margin: 0 0 14pt; }
    .message header { display: flex; justify-content: space-between; color: #374151; font-size: 9pt; }
    time { color: #6b7280; }
    h1, h2, h3, h4 { line-height: 1.25; }
    pre { background: #f3f4f6; padding: 10pt; white-space: pre-wrap; overflow-wrap: anywhere; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9pt; }
    blockquote { border-left: 3px solid #cbd5e1; margin-left: 0; padding-left: 12pt; color: #475569; }
    a { color: #2563eb; text-decoration: underline; overflow-wrap: anywhere; }
    img { max-width: 100%; }
  </style></head><body><h1>${escapeHtml(title)}</h1>${messageHtml}</body></html>`;
}

function parseInline(tokens: MarkdownToken[] = [], style: RunStyle = {}) {
  const runs: Array<TextRun | ExternalHyperlink> = [];

  for (const token of tokens) {
    const tokenText = token.text ?? "";
    if (
      token.type === "strong" ||
      token.type === "em" ||
      token.type === "del"
    ) {
      runs.push(
        ...parseInline(token.tokens, {
          ...style,
          bold: style.bold || token.type === "strong",
          italics: style.italics || token.type === "em",
          strike: style.strike || token.type === "del",
        }),
      );
      continue;
    }

    if (token.type === "link" && token.href && isSupportedLink(token.href)) {
      runs.push(
        new ExternalHyperlink({
          link: token.href,
          children: parseInline(token.tokens, { ...style, link: true }),
        }),
      );
      continue;
    }

    if (token.type === "link" || token.type === "image") {
      runs.push(...parseInline(token.tokens, style));
      if (!token.tokens?.length && tokenText) {
        runs.push(
          new TextRun({
            text: tokenText,
            bold: style.bold,
            italics: style.italics,
          }),
        );
      }
      continue;
    }

    if (token.type === "br") {
      runs.push(new TextRun({ text: "\n" }));
      continue;
    }

    const text =
      token.type === "html" ? tokenText.replace(/<[^>]*>/g, "") : tokenText;
    if (!text && token.type !== "codespan") continue;
    const isCode = style.code || token.type === "codespan";
    const isLink = style.link;
    runs.push(
      new TextRun({
        text,
        bold: style.bold,
        italics: style.italics,
        strike: style.strike,
        font: isCode ? "Courier New" : undefined,
        color: isLink ? "2563EB" : undefined,
        underline: isLink ? { type: "single" } : undefined,
      }),
    );
  }

  return runs;
}

function plainInline(text: string) {
  const tokens = markdown.lexer(text, { gfm: true }) as MarkdownToken[];
  return tokens.flatMap((token) => token.tokens ?? [token]);
}

function createDocxContent(messages: ChatMessage[], title: string) {
  const numberedLists: Array<{
    reference: string;
    levels: Array<{
      level: number;
      format: (typeof LevelFormat)[keyof typeof LevelFormat];
      text: string;
      alignment: (typeof AlignmentType)[keyof typeof AlignmentType];
      start: number;
    }>;
  }> = [];
  let listId = 0;

  const blocks = (tokens: MarkdownToken[], indent = 0): Paragraph[] => {
    const paragraphs: Paragraph[] = [];
    for (const token of tokens) {
      const inline = token.tokens ?? plainInline(token.text ?? "");
      const left = indent * 360;

      if (token.type === "space") continue;
      if (token.type === "heading") {
        const headingLevels = [
          HeadingLevel.HEADING_1,
          HeadingLevel.HEADING_2,
          HeadingLevel.HEADING_3,
          HeadingLevel.HEADING_4,
          HeadingLevel.HEADING_5,
          HeadingLevel.HEADING_6,
        ];
        const heading =
          headingLevels[Math.min(Math.max((token.depth ?? 1) - 1, 0), 5)];
        paragraphs.push(
          new Paragraph({
            heading,
            children: parseInline(inline),
            indent: { left },
          }),
        );
      } else if (token.type === "paragraph" || token.type === "text") {
        paragraphs.push(
          new Paragraph({ children: parseInline(inline), indent: { left } }),
        );
      } else if (token.type === "code") {
        const codeLines = (token.text ?? "").split("\n");
        for (const line of codeLines) {
          paragraphs.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: line || " ",
                  font: "Courier New",
                  size: 19,
                }),
              ],
              indent: { left: left + 240 },
              spacing: { before: 0, after: 0 },
            }),
          );
        }
      } else if (token.type === "blockquote") {
        paragraphs.push(...blocks(token.tokens ?? [], indent + 1));
      } else if (token.type === "list") {
        const orderedReference = token.ordered
          ? `chat-list-${listId++}`
          : undefined;
        if (orderedReference) {
          numberedLists.push({
            reference: orderedReference,
            levels: Array.from({ length: 9 }, (_, level) => ({
              level,
              format: LevelFormat.DECIMAL,
              text: `%${level + 1}.`,
              alignment: AlignmentType.START,
              start: level === 0 ? (token.start ?? 1) : 1,
            })),
          });
        }

        (token.items ?? []).forEach((item) => {
          const itemTokens = item.tokens ?? plainInline(item.text ?? "");
          const firstBlockIndex = itemTokens.findIndex(
            (itemToken) =>
              itemToken.type !== "space" && itemToken.type !== "list",
          );
          const firstBlock = itemTokens[firstBlockIndex];
          const firstRuns = firstBlock
            ? parseInline(
                firstBlock.tokens ?? plainInline(firstBlock.text ?? ""),
              )
            : parseInline(plainInline(item.text ?? ""));
          const level = Math.min(indent, 8);
          paragraphs.push(
            new Paragraph({
              children: firstRuns,
              bullet: token.ordered ? undefined : { level },
              numbering: orderedReference
                ? { reference: orderedReference, level }
                : undefined,
              indent: token.ordered ? { left: left + 360 } : undefined,
            }),
          );
          const remaining = itemTokens.filter(
            (itemToken, itemIndex) =>
              itemIndex !== firstBlockIndex && itemToken.type !== "space",
          );
          paragraphs.push(...blocks(remaining, indent + 1));
        });
      } else if (token.type === "table") {
        const rows = [token.header ?? [], ...(token.rows ?? [])];
        rows.forEach((row, rowIndex) => {
          paragraphs.push(
            new Paragraph({
              children: row.flatMap((cell, cellIndex) => [
                ...(cellIndex ? [new TextRun({ text: "  |  " })] : []),
                ...parseInline(cell.tokens ?? plainInline(cell.text ?? ""), {
                  bold: rowIndex === 0,
                }),
              ]),
              indent: { left },
            }),
          );
        });
      } else if (token.type === "hr") {
        paragraphs.push(new Paragraph({ text: "" }));
      }
    }
    return paragraphs;
  };

  const children: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, text: title }),
  ];

  for (const message of messages) {
    if (!message.text.trim()) continue;
    const role =
      message.sender === "user"
        ? "You"
        : message.sender === "system"
          ? "System"
          : "Muse AI";
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: role, bold: true })],
      }),
      new Paragraph({
        children: [
          new TextRun({ text: message.timestamp, color: "64748B", size: 18 }),
        ],
      }),
    );
    children.push(
      ...blocks(markdown.lexer(message.text, { gfm: true }) as MarkdownToken[]),
    );
  }

  return new Document({
    numbering: { config: numberedLists },
    sections: [{ children }],
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function isUserCancellation(error: unknown) {
  const value = error as { code?: unknown; message?: unknown; name?: unknown };
  const details = [value?.code, value?.message, value?.name]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  return /cancel|abort|dismiss/.test(details);
}

async function saveBase64File(
  base64: string,
  filename: string,
  format: ChatExportFormat,
): Promise<boolean> {
  const mimeType =
    format === "pdf"
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const permission =
    await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return false;

  const destinationUri =
    await FileSystem.StorageAccessFramework.createFileAsync(
      permission.directoryUri,
      filename,
      mimeType,
    );
  await FileSystem.writeAsStringAsync(destinationUri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return true;
}

async function shareWebFile(blob: Blob, filename: string) {
  const file = new File([blob], filename, { type: blob.type });
  const webNavigator = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[]; title: string }) => Promise<void>;
  };

  if (webNavigator.share && webNavigator.canShare?.({ files: [file] })) {
    await webNavigator.share({ files: [file], title: "Export chat" });
  } else {
    downloadBlob(blob, filename);
  }
}

async function shareNativeFile(uri: string, format: ChatExportFormat) {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("File sharing is unavailable on this device.");
  }

  await Sharing.shareAsync(uri, {
    mimeType:
      format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    dialogTitle: "Export chat",
    UTI:
      format === "pdf"
        ? "com.adobe.pdf"
        : "org.openxmlformats.wordprocessingml.document",
  });
}

async function writeBase64ToCache(base64: string, filename: string) {
  const directory = FileSystem.cacheDirectory;
  if (!directory)
    throw new Error("A temporary export directory is unavailable.");
  const uri = `${directory}${filename}`;
  await FileSystem.writeAsStringAsync(uri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return uri;
}

export async function exportChat(
  messages: ChatMessage[],
  title: string,
  format: ChatExportFormat,
  destination: ChatExportDestination,
): Promise<boolean> {
  const filename = createExportFilename(title);

  try {
    if (format === "pdf") {
      const html = renderPdfHtml(messages, title);
      if (Platform.OS === "web") {
        await Print.printToFileAsync({ html });
        return true;
      }

      const { base64 } = await Print.printToFileAsync({ html, base64: true });
      if (!base64) throw new Error("The PDF could not be generated.");
      if (destination === "download" && Platform.OS === "android") {
        return await saveBase64File(base64, `${filename}.pdf`, format);
      }

      const uri = await writeBase64ToCache(base64, `${filename}.pdf`);
      await shareNativeFile(uri, format);
      return true;
    }

    const document = createDocxContent(messages, title);
    if (Platform.OS === "web") {
      const blob = await Packer.toBlob(document);
      if (destination === "share") {
        await shareWebFile(blob, `${filename}.docx`);
      } else {
        downloadBlob(blob, `${filename}.docx`);
      }
      return true;
    }

    const base64 = await Packer.toBase64String(document);
    if (destination === "download" && Platform.OS === "android") {
      return await saveBase64File(base64, `${filename}.docx`, format);
    }

    const uri = await writeBase64ToCache(base64, `${filename}.docx`);
    await shareNativeFile(uri, format);
    return true;
  } catch (error) {
    if (isUserCancellation(error)) return false;
    throw error;
  }
}

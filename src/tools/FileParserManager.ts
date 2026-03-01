import { FileSystemAdapter, Notice, TFile, Vault } from "obsidian";
import { ProjectConfig } from "@/aiParams";
import { PDFCache } from "@/cache/pdfCache";
import { ProjectContextCache } from "@/cache/projectContextCache";
import { logError, logInfo, logWarn } from "@/logger";
import { MiyoClient } from "@/miyo/MiyoClient";
import { getSettings } from "@/settings/model";
import { saveConvertedDocOutput as saveConvertedDocOutputCore } from "@/utils/convertedDocOutput";
import { extractRetryTime, isRateLimitError } from "@/utils/rateLimitUtils";
import { CanvasLoader } from "./CanvasLoader";

interface FileParser {
  supportedExtensions: string[];
  parseFile: (file: TFile, vault: Vault) => Promise<string>;
}

/**
 * Thin wrapper that reads the output folder from settings and delegates to the pure function.
 */
export async function saveConvertedDocOutput(
  file: TFile,
  content: string,
  vault: Vault,
): Promise<void> {
  const outputFolder = getSettings().convertedDocOutputFolder ?? "";
  await saveConvertedDocOutputCore(file, content, vault, outputFolder);
}

/**
 * Resolve absolute file path for a vault file when supported by the adapter.
 *
 * @param file - Target file.
 * @param vault - Obsidian vault instance.
 * @returns Absolute file path or null when unavailable.
 */
function resolveAbsoluteFilePath(file: TFile, vault: Vault): string | null {
  const adapter = vault.adapter;
  if (adapter instanceof FileSystemAdapter) {
    return adapter.getFullPath(file.path);
  }

  const adapterAny = adapter as unknown as { getFullPath?: (normalizedPath: string) => string };
  if (typeof adapterAny.getFullPath === "function") {
    return adapterAny.getFullPath(file.path);
  }

  return null;
}

/** Result from SelfHostPdfParser: null = not applicable, { content } = success, { error } = tried and failed. */
type MiyoParseResult = { content: string } | { error: string } | null;

/**
 * Self-host PDF parser bridge using Miyo parse-doc endpoint.
 */
class SelfHostPdfParser {
  private miyoClient: MiyoClient;

  /**
   * Create a new self-host PDF parser.
   */
  constructor() {
    this.miyoClient = new MiyoClient();
  }

  /**
   * Parse a PDF via Miyo when self-host mode is active.
   *
   * @param file - PDF file to parse.
   * @param vault - Obsidian vault instance.
   * @returns Content on success, error reason on failure, or null when not applicable.
   */
  public async parsePdf(file: TFile, vault: Vault): Promise<MiyoParseResult> {
    const settings = getSettings();
    if (!settings.enableMiyo || file.extension.toLowerCase() !== "pdf") {
      return null;
    }

    const absolutePath = resolveAbsoluteFilePath(file, vault);
    if (!absolutePath) {
      return { error: "Could not resolve absolute file path for Miyo parse-doc" };
    }

    try {
      const baseUrl = await this.miyoClient.resolveBaseUrl(settings.selfHostUrl);
      const response = await this.miyoClient.parseDoc(baseUrl, absolutePath);
      if (typeof response.text !== "string" || response.text.trim().length === 0) {
        return { error: "Miyo parse-doc returned empty text" };
      }

      logInfo(`[SelfHostPdfParser] Parsed PDF via Miyo: ${file.path}`);
      return { content: response.text };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logWarn(`[SelfHostPdfParser] Failed to parse ${file.path} via Miyo parse-doc: ${reason}`);
      return { error: reason };
    }
  }
}

export class MarkdownParser implements FileParser {
  supportedExtensions = ["md"];

  async parseFile(file: TFile, vault: Vault): Promise<string> {
    return await vault.read(file);
  }
}

export class PDFParser implements FileParser {
  supportedExtensions = ["pdf"];
  private pdfCache: PDFCache;
  private selfHostPdfParser: SelfHostPdfParser;

  constructor() {
    this.pdfCache = PDFCache.getInstance();
    this.selfHostPdfParser = new SelfHostPdfParser();
  }

  async parseFile(file: TFile, vault: Vault): Promise<string> {
    try {
      logInfo("Parsing PDF file:", file.path);

      // Try to get from cache first
      const cachedResponse = await this.pdfCache.get(file);
      if (cachedResponse) {
        logInfo("Using cached PDF content for:", file.path);
        // Ensure output file exists even on cache hit (user may have just enabled the setting)
        await saveConvertedDocOutput(file, cachedResponse.response, vault);
        return cachedResponse.response;
      }

      const settings = getSettings();
      if (settings.enableMiyo && file.extension.toLowerCase() === "pdf") {
        const miyoResult = await this.selfHostPdfParser.parsePdf(file, vault);
        if (miyoResult && "content" in miyoResult) {
          await this.pdfCache.set(file, {
            response: miyoResult.content,
            elapsed_time_ms: 0,
          });
          await saveConvertedDocOutput(file, miyoResult.content, vault);
          return miyoResult.content;
        }

        if (miyoResult && "error" in miyoResult) {
          logWarn(`[PDFParser] Miyo parse failed for ${file.path}: ${miyoResult.error}`);
          // Fall through to SelfHostPdfParser direct attempt
        }
      }

      // Try direct SelfHostPdfParser as last resort
      const directResult = await this.selfHostPdfParser.parsePdf(file, vault);
      if (directResult && "content" in directResult) {
        await this.pdfCache.set(file, {
          response: directResult.content,
          elapsed_time_ms: 0,
        });
        await saveConvertedDocOutput(file, directResult.content, vault);
        return directResult.content;
      }

      return `[Error: Could not extract content from PDF ${file.basename}. No PDF processing service is configured.]`;
    } catch (error) {
      logError(`Error extracting content from PDF ${file.path}:`, error);
      return `[Error: Could not extract content from PDF ${file.basename}]`;
    }
  }

  async clearCache(): Promise<void> {
    logInfo("Clearing PDF cache");
    await this.pdfCache.clear();
  }
}

export class CanvasParser implements FileParser {
  supportedExtensions = ["canvas"];

  async parseFile(file: TFile, vault: Vault): Promise<string> {
    try {
      logInfo("Parsing Canvas file:", file.path);
      const canvasLoader = new CanvasLoader(vault);
      const canvasData = await canvasLoader.load(file);

      // Use the specialized buildPrompt method to create LLM-friendly format
      return canvasLoader.buildPrompt(canvasData);
    } catch (error) {
      logError(`Error parsing Canvas file ${file.path}:`, error);
      return `[Error: Could not parse Canvas file ${file.basename}]`;
    }
  }
}

export class Docs4LLMParser implements FileParser {
  // Support various document and media file types
  supportedExtensions = [
    // Base types
    "pdf",

    // Documents and presentations
    "602",
    "abw",
    "cgm",
    "cwk",
    "doc",
    "docx",
    "docm",
    "dot",
    "dotm",
    "hwp",
    "key",
    "lwp",
    "mw",
    "mcw",
    "pages",
    "pbd",
    "ppt",
    "pptm",
    "pptx",
    "pot",
    "potm",
    "potx",
    "rtf",
    "sda",
    "sdd",
    "sdp",
    "sdw",
    "sgl",
    "sti",
    "sxi",
    "sxw",
    "stw",
    "sxg",
    "txt",
    "uof",
    "uop",
    "uot",
    "vor",
    "wpd",
    "wps",
    "xml",
    "zabw",
    "epub",

    // Images
    "jpg",
    "jpeg",
    "png",
    "gif",
    "bmp",
    "svg",
    "tiff",
    "webp",
    "web",
    "htm",
    "html",

    // Spreadsheets
    "xlsx",
    "xls",
    "xlsm",
    "xlsb",
    "xlw",
    "csv",
    "dif",
    "sylk",
    "slk",
    "prn",
    "numbers",
    "et",
    "ods",
    "fods",
    "uos1",
    "uos2",
    "dbf",
    "wk1",
    "wk2",
    "wk3",
    "wk4",
    "wks",
    "123",
    "wq1",
    "wq2",
    "wb1",
    "wb2",
    "wb3",
    "qpw",
    "xlr",
    "eth",
    "tsv",

    // Audio (limited to 20MB)
    "mp3",
    "mp4",
    "mpeg",
    "mpga",
    "m4a",
    "wav",
    "webm",
  ];
  private projectContextCache: ProjectContextCache;
  private selfHostPdfParser: SelfHostPdfParser;
  private currentProject: ProjectConfig | null;
  private static lastRateLimitNoticeTime: number = 0;

  public static resetRateLimitNoticeTimer(): void {
    Docs4LLMParser.lastRateLimitNoticeTime = 0;
  }

  constructor(project: ProjectConfig | null = null) {
    this.projectContextCache = ProjectContextCache.getInstance();
    this.selfHostPdfParser = new SelfHostPdfParser();
    this.currentProject = project;
  }

  async parseFile(file: TFile, vault: Vault): Promise<string> {
    try {
      logInfo(
        `[Docs4LLMParser] Project ${this.currentProject?.name}: Parsing ${file.extension} file: ${file.path}`,
      );

      if (!this.currentProject) {
        logError("[Docs4LLMParser] No project context for parsing file: ", file.path);
        throw new Error("No project context provided for file parsing");
      }

      const cachedContent = await this.projectContextCache.getOrReuseFileContext(
        this.currentProject,
        file.path,
      );
      if (cachedContent) {
        logInfo(
          `[Docs4LLMParser] Project ${this.currentProject.name}: Using cached content for: ${file.path}`,
        );
        // Ensure output file exists even on cache hit (user may have just enabled the setting)
        await saveConvertedDocOutput(file, cachedContent, vault);
        return cachedContent;
      }
      logInfo(
        `[Docs4LLMParser] Project ${this.currentProject.name}: Cache miss for: ${file.path}. Proceeding to API call.`,
      );

      // For PDFs, try Miyo first when self-host mode is active
      if (getSettings().enableMiyo && file.extension.toLowerCase() === "pdf") {
        const miyoResult = await this.selfHostPdfParser.parsePdf(file, vault);
        if (miyoResult && "content" in miyoResult) {
          await this.projectContextCache.setFileContext(
            this.currentProject,
            file.path,
            miyoResult.content,
          );
          await saveConvertedDocOutput(file, miyoResult.content, vault);
          logInfo(
            `[Docs4LLMParser] Project ${this.currentProject.name}: Parsed PDF via Miyo: ${file.path}`,
          );
          return miyoResult.content;
        }
        if (miyoResult && "error" in miyoResult) {
          throw new Error(`Miyo failed to parse ${file.basename}: ${miyoResult.error}`);
        }
      }

      // For PDFs without Miyo, try direct SelfHostPdfParser
      if (file.extension.toLowerCase() === "pdf") {
        const directResult = await this.selfHostPdfParser.parsePdf(file, vault);
        if (directResult && "content" in directResult) {
          await this.projectContextCache.setFileContext(
            this.currentProject,
            file.path,
            directResult.content,
          );
          await saveConvertedDocOutput(file, directResult.content, vault);
          return directResult.content;
        }
        throw new Error(
          `Could not parse PDF ${file.basename}. No PDF processing service configured.`,
        );
      }

      // Non-PDF document types: no longer supported without external service
      throw new Error(
        "Document conversion for this file type requires a configured document processing service.",
      );
    } catch (error) {
      logError(
        `[Docs4LLMParser] Project ${this.currentProject?.name}: Error processing file ${file.path}:`,
        error,
      );

      // Check if this is a rate limit error and show user-friendly notice
      if (isRateLimitError(error)) {
        this.showRateLimitNotice(error);
      }

      throw error; // Propagate the error up
    }
  }

  private showRateLimitNotice(error: any): void {
    const now = Date.now();

    // Only show one rate limit notice per minute to avoid spam
    if (now - Docs4LLMParser.lastRateLimitNoticeTime < 60000) {
      return;
    }

    Docs4LLMParser.lastRateLimitNoticeTime = now;

    const retryTime = extractRetryTime(error);

    new Notice(
      `⚠️ Rate limit exceeded for document processing. Please try again in ${retryTime}. Having fewer non-markdown files in the project will help.`,
      10000, // Show notice for 10 seconds
    );
  }

  async clearCache(): Promise<void> {
    // This method is no longer needed as cache clearing is handled at the project level
    logInfo("Cache clearing is now handled at the project level");
  }
}

// Future parsers can be added like this:
/*
class DocxParser implements FileParser {
  supportedExtensions = ["docx", "doc"];

  async parseFile(file: TFile, vault: Vault): Promise<string> {
    // Implementation for Word documents
  }
}
*/

export class FileParserManager {
  private parsers: Map<string, FileParser> = new Map();

  constructor(_vault: Vault, isProjectMode: boolean = false, project: ProjectConfig | null = null) {
    // Register parsers
    this.registerParser(new MarkdownParser());

    // In project mode, use Docs4LLMParser for all supported files including PDFs
    this.registerParser(new Docs4LLMParser(project));

    // Only register PDFParser when not in project mode
    if (!isProjectMode) {
      this.registerParser(new PDFParser());
    }

    this.registerParser(new CanvasParser());
  }

  registerParser(parser: FileParser) {
    for (const ext of parser.supportedExtensions) {
      this.parsers.set(ext, parser);
    }
  }

  async parseFile(file: TFile, vault: Vault): Promise<string> {
    const parser = this.parsers.get(file.extension);
    if (!parser) {
      throw new Error(`No parser found for file type: ${file.extension}`);
    }
    return await parser.parseFile(file, vault);
  }

  supportsExtension(extension: string): boolean {
    return this.parsers.has(extension);
  }

  async clearPDFCache(): Promise<void> {
    const pdfParser = this.parsers.get("pdf");
    if (pdfParser instanceof PDFParser) {
      await pdfParser.clearCache();
    }
  }
}

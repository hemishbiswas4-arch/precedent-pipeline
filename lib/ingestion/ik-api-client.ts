import { IkRawDocument } from "@/lib/ingestion/normalize";

type IkApiListResponse = {
  docs?: unknown;
  results?: unknown;
  items?: unknown;
  data?: unknown;
  hits?: unknown;
  found?: number | string;
  categories?: unknown;
  encodedformInput?: string;
  formInput?: string;
  pagenum?: number;
};

export type IkApiSearchParams = {
  formInput?: string;
  query?: string;
  pagenum?: number;
  page?: number;
  perPage?: number;
  maxpages?: number;
  doctypes?: string;
  court?: "SC" | "HC" | "ANY";
  fromdate?: string;
  todate?: string;
  fromDate?: string;
  toDate?: string;
  title?: string;
  cite?: string;
  author?: string;
  bench?: string;
  maxcites?: number;
};

export type IkApiSearchResult = {
  rows: IkRawDocument[];
  status: number;
  retryAfterMs?: number;
  found?: number | string;
  categories?: unknown;
  pagenum?: number;
  encodedFormInput?: string;
};

export type IkApiClientConfig = {
  baseUrl: string;
  apiKey: string;
  searchPath?: string;
  detailPathTemplate?: string;
  courtCopyPathTemplate?: string;
  docFragmentPathTemplate?: string;
  docMetaPathTemplate?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export class IkApiClientError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly endpoint?: string;

  constructor(
    message: string,
    input: {
      status: number;
      retryAfterMs?: number;
      endpoint?: string;
    },
  ) {
    super(message);
    this.name = "IkApiClientError";
    this.status = input.status;
    this.retryAfterMs = input.retryAfterMs;
    this.endpoint = input.endpoint;
  }
}

const DEFAULT_TIMEOUT_MS = Math.max(1_500, Number(process.env.IK_API_TIMEOUT_MS ?? "4500"));
const DEFAULT_MAX_RETRIES = Math.max(0, Math.min(Number(process.env.IK_API_MAX_RETRIES ?? "1"), 3));

function normalizeText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return [];
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 1200;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.max(500, Math.min(numeric * 1000, 8_000));
  }
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    return Math.max(500, Math.min(asDate - Date.now(), 8_000));
  }
  return 1200;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function encodeDocPath(pathTemplate: string, docId: string): string {
  return pathTemplate.replace("{docId}", encodeURIComponent(docId));
}

function normalizeDateForApi(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const yyyyMmDd = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (yyyyMmDd) {
    const year = Number(yyyyMmDd[1]);
    const month = Number(yyyyMmDd[2]);
    const day = Number(yyyyMmDd[3]);
    return `${day}-${month}-${year}`;
  }

  const ddMmYyyy = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (ddMmYyyy) {
    const day = Number(ddMmYyyy[1]);
    const month = Number(ddMmYyyy[2]);
    const year = Number(ddMmYyyy[3]);
    return `${day}-${month}-${year}`;
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    const day = parsed.getUTCDate();
    const month = parsed.getUTCMonth() + 1;
    const year = parsed.getUTCFullYear();
    return `${day}-${month}-${year}`;
  }

  return undefined;
}

function doctypeForCourt(court: "SC" | "HC" | "ANY" | undefined): string | undefined {
  if (!court || court === "ANY") return undefined;
  if (court === "SC") return "supremecourt";
  return "highcourts";
}

function flattenCitationValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      if (typeof row.value === "string") out.push(row.value);
      if (typeof row.title === "string") out.push(row.title);
      if (typeof row.cite === "string") out.push(row.cite);
    }
  }
  return out;
}

function mapRowToRawDocument(row: Record<string, unknown>): IkRawDocument {
  const tid = (row.tid as string | number | undefined) ?? (row.id as string | number | undefined);
  const link =
    (row.url as string | undefined) ??
    (row.docurl as string | undefined) ??
    (row.link as string | undefined) ??
    (tid ? `https://indiankanoon.org/doc/${tid}/` : undefined);

  return {
    id: (row.id as string | number | undefined) ?? tid,
    tid,
    docId: (row.docId as string | number | undefined) ?? tid,
    documentId: (row.documentId as string | number | undefined) ?? tid,
    title: normalizeText(String(row.title ?? row.caseTitle ?? row.headline ?? "")),
    headline: normalizeText(String(row.headline ?? row.snippet ?? "")),
    docsource: normalizeText(String(row.docsource ?? "")),
    court: normalizeText(String(row.court ?? row.docsource ?? row.courtName ?? "")),
    courtName: normalizeText(String(row.courtName ?? row.docsource ?? "")),
    decisionDate: normalizeText(String(row.decisionDate ?? row.publishdate ?? row.judgmentDate ?? "")),
    publishdate: normalizeText(String(row.publishdate ?? "")),
    date: normalizeText(String(row.date ?? row.publishdate ?? "")),
    docsize: typeof row.docsize === "number" ? row.docsize : Number(row.docsize ?? 0) || undefined,
    url: normalizeText(String(link ?? "")),
    permalink: normalizeText(String(row.permalink ?? link ?? "")),
    citations: flattenCitationValues(row.citeList),
    equivalentCitations: flattenCitationValues(row.citedbyList),
    statutes: toArray<string>(row.statutes),
    sections: toArray<string>(row.sections),
    text: normalizeText(String(row.text ?? row.content ?? row.body ?? row.doc ?? "")),
    judgmentText: normalizeText(String(row.judgmentText ?? row.doc ?? "")),
    snippet: normalizeText(String(row.headline ?? row.snippet ?? row.summary ?? "")),
  };
}

export class IndianKanoonApiClient {
  private readonly config: Required<IkApiClientConfig>;

  constructor(config?: Partial<IkApiClientConfig>) {
    const baseUrl = ensureBaseUrl(config?.baseUrl?.trim() ?? process.env.IK_API_BASE_URL?.trim() ?? "");
    const apiKey = config?.apiKey?.trim() ?? process.env.IK_API_KEY?.trim() ?? "";

    if (!baseUrl) throw new Error("IK_API_BASE_URL missing");
    if (!apiKey) throw new Error("IK_API_KEY missing");

    this.config = {
      baseUrl,
      apiKey,
      searchPath: config?.searchPath ?? "/search/",
      detailPathTemplate: config?.detailPathTemplate ?? "/doc/{docId}/",
      courtCopyPathTemplate: config?.courtCopyPathTemplate ?? "/origdoc/{docId}/",
      docFragmentPathTemplate: config?.docFragmentPathTemplate ?? "/docfragment/{docId}/",
      docMetaPathTemplate: config?.docMetaPathTemplate ?? "/docmeta/{docId}/",
      timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: config?.maxRetries ?? DEFAULT_MAX_RETRIES,
    };
  }

  private buildSearchUrl(params: IkApiSearchParams): URL {
    const formInput = (params.formInput ?? params.query ?? "").trim();
    if (!formInput) {
      throw new Error("ik_api_search_missing_formInput");
    }

    const url = new URL(this.config.searchPath, this.config.baseUrl);
    url.searchParams.set("formInput", formInput);

    const pagenum =
      params.pagenum ??
      (typeof params.page === "number" ? Math.max(0, Math.floor(params.page) - 1) : 0);
    url.searchParams.set("pagenum", String(Math.max(0, Math.floor(pagenum))));

    if (typeof params.maxpages === "number" && Number.isFinite(params.maxpages) && params.maxpages > 0) {
      url.searchParams.set("maxpages", String(Math.min(Math.floor(params.maxpages), 1000)));
    }

    const doctypes = (params.doctypes ?? doctypeForCourt(params.court))?.trim();
    if (doctypes) {
      url.searchParams.set("doctypes", doctypes);
    }

    const fromdate = normalizeDateForApi(params.fromdate ?? params.fromDate);
    const todate = normalizeDateForApi(params.todate ?? params.toDate);
    if (fromdate) url.searchParams.set("fromdate", fromdate);
    if (todate) url.searchParams.set("todate", todate);

    if (params.title?.trim()) url.searchParams.set("title", params.title.trim());
    if (params.cite?.trim()) url.searchParams.set("cite", params.cite.trim());
    if (params.author?.trim()) url.searchParams.set("author", params.author.trim());
    if (params.bench?.trim()) url.searchParams.set("bench", params.bench.trim());

    if (typeof params.maxcites === "number" && Number.isFinite(params.maxcites) && params.maxcites > 0) {
      url.searchParams.set("maxcites", String(Math.min(Math.floor(params.maxcites), 50)));
    }

    return url;
  }

  private buildDocUrl(docId: string): URL {
    return new URL(encodeDocPath(this.config.detailPathTemplate, docId), this.config.baseUrl);
  }

  private buildCourtCopyUrl(docId: string): URL {
    return new URL(encodeDocPath(this.config.courtCopyPathTemplate, docId), this.config.baseUrl);
  }

  private buildDocFragmentUrl(docId: string, formInput: string): URL {
    const url = new URL(encodeDocPath(this.config.docFragmentPathTemplate, docId), this.config.baseUrl);
    url.searchParams.set("formInput", formInput);
    return url;
  }

  private buildDocMetaUrl(docId: string): URL {
    return new URL(encodeDocPath(this.config.docMetaPathTemplate, docId), this.config.baseUrl);
  }

  private async requestJson(
    url: URL,
    method: "POST" | "GET" = "POST",
    options?: { timeoutMs?: number; endpoint?: string },
  ): Promise<{ status: number; payload: unknown; retryAfterMs?: number }> {
    let attempt = 0;
    const timeoutMs = Math.max(250, options?.timeoutMs ?? this.config.timeoutMs);

    while (attempt <= this.config.maxRetries) {
      attempt += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Token ${this.config.apiKey}`,
            Accept: "application/json",
          },
          cache: "no-store",
          signal: controller.signal,
        });

        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        if ((response.status === 429 || response.status === 503) && attempt <= this.config.maxRetries) {
          await sleep(retryAfterMs + attempt * 120);
          continue;
        }

        const payload = await response.json().catch(() => ({}));
        return {
          status: response.status,
          payload,
          retryAfterMs: response.status === 429 ? retryAfterMs : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt <= this.config.maxRetries) {
          await sleep(220 * attempt);
          continue;
        }
        throw new IkApiClientError(`ik_api_request_failed:${message}`, {
          status: 0,
          endpoint: options?.endpoint,
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new IkApiClientError("ik_api_request_failed:retry_exhausted", {
      status: 0,
      endpoint: options?.endpoint,
    });
  }

  async search(params: IkApiSearchParams): Promise<IkApiSearchResult> {
    const url = this.buildSearchUrl(params);
    const response = await this.requestJson(url, "POST", { endpoint: "search" });

    if (response.status >= 400) {
      throw new IkApiClientError(`ik_api_search_http_${response.status}`, {
        status: response.status,
        retryAfterMs: response.retryAfterMs,
        endpoint: "search",
      });
    }

    const payload = response.payload as IkApiListResponse;
    const docsRows = toArray<Record<string, unknown>>(payload.docs);
    const resultRows = toArray<Record<string, unknown>>(payload.results);
    const itemRows = toArray<Record<string, unknown>>(payload.items);
    const dataRows = toArray<Record<string, unknown>>(payload.data);
    const hitRows = toArray<Record<string, unknown>>(payload.hits);

    const rows =
      docsRows.length > 0
        ? docsRows
        : resultRows.length > 0
          ? resultRows
          : itemRows.length > 0
            ? itemRows
            : dataRows.length > 0
              ? dataRows
              : hitRows;

    return {
      rows: rows.map(mapRowToRawDocument),
      status: response.status,
      retryAfterMs: response.retryAfterMs,
      found: typeof payload.found === "number" || typeof payload.found === "string" ? payload.found : undefined,
      categories: payload.categories,
      pagenum: typeof payload.pagenum === "number" ? payload.pagenum : undefined,
      encodedFormInput: typeof payload.encodedformInput === "string" ? payload.encodedformInput : undefined,
    };
  }

  async fetchDocument(docId: string, options?: { maxcites?: number; maxcitedby?: number }): Promise<IkRawDocument> {
    const url = this.buildDocUrl(docId);
    if (typeof options?.maxcites === "number" && options.maxcites > 0) {
      url.searchParams.set("maxcites", String(Math.min(Math.floor(options.maxcites), 50)));
    }
    if (typeof options?.maxcitedby === "number" && options.maxcitedby > 0) {
      url.searchParams.set("maxcitedby", String(Math.min(Math.floor(options.maxcitedby), 50)));
    }

    const response = await this.requestJson(url, "POST", { endpoint: "doc" });
    if (response.status >= 400) {
      throw new IkApiClientError(`ik_api_doc_http_${response.status}`, {
        status: response.status,
        retryAfterMs: response.retryAfterMs,
        endpoint: "doc",
      });
    }

    return mapRowToRawDocument(response.payload as Record<string, unknown>);
  }

  async fetchDocFragment(docId: string, formInput: string, options?: { timeoutMs?: number }): Promise<IkRawDocument> {
    const url = this.buildDocFragmentUrl(docId, formInput);
    const response = await this.requestJson(url, "POST", {
      endpoint: "docfragment",
      timeoutMs: options?.timeoutMs,
    });
    if (response.status >= 400) {
      throw new IkApiClientError(`ik_api_docfragment_http_${response.status}`, {
        status: response.status,
        retryAfterMs: response.retryAfterMs,
        endpoint: "docfragment",
      });
    }
    return mapRowToRawDocument(response.payload as Record<string, unknown>);
  }

  async fetchDocMeta(docId: string): Promise<IkRawDocument> {
    const url = this.buildDocMetaUrl(docId);
    const response = await this.requestJson(url, "POST", { endpoint: "docmeta" });
    if (response.status >= 400) {
      throw new IkApiClientError(`ik_api_docmeta_http_${response.status}`, {
        status: response.status,
        retryAfterMs: response.retryAfterMs,
        endpoint: "docmeta",
      });
    }
    return mapRowToRawDocument(response.payload as Record<string, unknown>);
  }

  async fetchCourtCopy(docId: string): Promise<IkRawDocument> {
    const url = this.buildCourtCopyUrl(docId);
    const response = await this.requestJson(url, "POST", { endpoint: "origdoc" });
    if (response.status >= 400) {
      throw new IkApiClientError(`ik_api_origdoc_http_${response.status}`, {
        status: response.status,
        retryAfterMs: response.retryAfterMs,
        endpoint: "origdoc",
      });
    }
    return mapRowToRawDocument(response.payload as Record<string, unknown>);
  }

  static isConfigured(): boolean {
    return Boolean(process.env.IK_API_BASE_URL?.trim() && process.env.IK_API_KEY?.trim());
  }
}

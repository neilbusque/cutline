export type StockProvider = "commons" | "pexels";
export type StockKind = "video" | "image";
export type StockOrientation = "all" | "portrait" | "landscape" | "square";
export type StockSearchOptions = {
  provider?: StockProvider;
  kind?: StockKind;
  orientation?: StockOrientation;
};

/** StockVideo is retained as an alias for projects built before photo search. */
export type StockItem = {
  id: number;
  key: string;
  provider: StockProvider;
  kind: StockKind;
  title: string;
  /** Plain provider description; never synthesized from the search query. */
  description?: string;
  creator: string;
  license: string;
  licenseUrl: string;
  page: string;
  thumbnail: string;
  url: string;
  preview: string;
  duration: number;
  width: number;
  height: number;
  size: number;
};
export type StockVideo = StockItem;
export type StockQuota = {
  remaining?: number;
  limit?: number;
  resetAt?: number;
};
export type StockResults = {
  items: StockItem[];
  /** Compatibility collection; contains the chosen media kind. */
  videos: StockItem[];
  provider: StockProvider;
  kind: StockKind;
  next?: number;
  quota?: StockQuota;
  cached?: boolean;
};
export type StockCredentialStatus = {
  pexelsConfigured: boolean;
  secureStorageAvailable: boolean | null;
  storageError?: string;
};

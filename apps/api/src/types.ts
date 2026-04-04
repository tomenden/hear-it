export interface ExtractArticleInput {
  url: string;
  html?: string;
}

export interface ExtractedArticle {
  url: string;
  title: string | null;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  textContent: string;
  wordCount: number;
  estimatedMinutes: number;
}

export interface SpeechOptions {
  voice: string;
}

export type SpeechChunkFormat = "wav" | "pcm" | "mp3";

export interface SpeechChunkMedia {
  audioData: Buffer;
  format: SpeechChunkFormat;
  contentType: string;
  durationSeconds: number;
  sampleRateHz: number;
  channelCount: number;
}

export interface PackagerChunkMedia extends SpeechChunkMedia {
  format: "mp3";
  contentType: "audio/mpeg";
}

export interface SpeechScriptNormalization {
  whitespaceCollapsed: number;
  separatorsRemoved: number;
  headingsLabeled: number;
  captionsLabeled: number;
  urlsHumanized: number;
  titleFallbackUsed: boolean;
}

export interface SpeechScript {
  displayTitle: string;
  script: string;
  speechScript: string;
  speechScriptVersion: number;
  normalization: SpeechScriptNormalization;
}

export type AudioJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export interface AudioRenderResult {
  audioUrl: string | null;
  playlistUrl: string | null;
  audioSegments: AudioSegment[];
  durationSeconds: number;
  audioData?: Buffer;
  contentType?: string;
  chunkMedia?: SpeechChunkMedia;
}

export interface AudioSegment {
  url: string;
  durationSeconds: number;
}

export interface AudioJob {
  id: string;
  status: AudioJobStatus;
  article: ExtractedArticle;
  speechOptions: SpeechOptions;
  provider: string;
  audioUrl: string | null;
  audioDownloadPath?: string | null;
  playlistUrl: string | null;
  audioSegments: AudioSegment[];
  durationSeconds: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  userId: string | null;
}

export interface CreateAudioJobInput extends ExtractArticleInput {
  speechOptions?: Partial<SpeechOptions>;
}

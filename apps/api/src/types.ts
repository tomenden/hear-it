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

export type AudioChunk = Uint8Array;
export interface AudioInput { data: Uint8Array; mimeType: string; sampleRate?: number }
export interface AudioOutput extends AudioInput { device?: string }
export interface STTOptions { language: string; vocabulary?: string[]; signal?: AbortSignal }
export interface TTSOptions { language: string; voice?: string; signal?: AbortSignal }
export interface Transcript { text: string; language?: string; confidence?: number }
export interface TranscriptEvent extends Transcript { final: boolean }
export interface SpeechToTextProvider {
  transcribe(audio: AudioInput, options: STTOptions): Promise<Transcript>;
  stream?(audio: AsyncIterable<AudioChunk>, options: STTOptions): AsyncIterable<TranscriptEvent>;
}
export interface TextToSpeechProvider {
  synthesize(text: string, options: TTSOptions): Promise<AudioOutput>;
  stream?(text: AsyncIterable<string>, options: TTSOptions): AsyncIterable<AudioChunk>;
}
export interface WakeWordConfig { phrases: string[]; sensitivity: number; localOnly: boolean }
export interface WakeWordEvent { phrase: string; confidence?: number; timestamp: number }
export interface WakeWordProvider {
  start(config: WakeWordConfig): AsyncIterable<WakeWordEvent>;
  stop(): Promise<void>;
}

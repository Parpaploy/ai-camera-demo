export type Mode = "image" | "camera";
export type Status = "idle" | "loading-model" | "running" | "done" | "error";

export type AttireType = "student" | "general" | "uncertain";

export type PersonDescriptionState = {
  loading: boolean;
  text?: string;
  error?: string;
  thumbnail?: string;
  attire?: AttireType;
};

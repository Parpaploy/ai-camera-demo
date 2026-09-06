export type Mode = "image" | "camera";
export type Status = "idle" | "loading-model" | "running" | "done" | "error";

export type AttireDetectionMode = "student" | "medical";

export type AttireType = "target" | "other" | "uncertain";

export type GenderType = "male" | "female" | "unisex" | "uncertain";
export type AgeGroupType = "teen" | "adult" | "elderly" | "uncertain";

export type PersonDescriptionState = {
  loading: boolean;
  text?: string;
  error?: string;
  thumbnail?: string;
  attire?: AttireType;
  gender?: GenderType;
  ageGroup?: AgeGroupType;
};

export interface ModelOption {
  label: string;
  url: string;
  description: string;
}

export interface AttireModeOption {
  id: AttireDetectionMode;
  label: string;
  description: string;
}

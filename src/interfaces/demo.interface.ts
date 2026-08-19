export type Mode = "image" | "camera";
export type Status = "idle" | "loading-model" | "running" | "done" | "error";

export type AttireType = "student" | "general" | "uncertain";

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

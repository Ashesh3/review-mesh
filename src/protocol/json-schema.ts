import { z } from "zod";
import { reviewerResultV3Schema } from "./schemas.js";

export const reviewerResultJsonSchema = z.toJSONSchema(reviewerResultV3Schema, {
  target: "draft-07",
});

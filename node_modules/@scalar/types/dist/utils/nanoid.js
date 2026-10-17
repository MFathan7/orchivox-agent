import { nanoid } from 'nanoid';
import { z } from 'zod';
/** Generates a default value */
export const nanoidSchema = z
    .string()
    .min(7)
    .default(() => nanoid());

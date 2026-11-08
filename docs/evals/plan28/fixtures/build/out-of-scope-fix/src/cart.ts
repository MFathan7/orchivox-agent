import { MAX_ITEMS } from "./config";

export function canAdd(current: number): boolean {
  return current < MAX_ITEMS;
}

export function search(records: Array<{ id: string; name: string }>, query: string): string[] {
  return records.filter((record) => record.name.includes(query)).map((record) => record.id);
}

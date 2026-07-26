export type CreatorBrowseState<Filter extends string> = {
  query: string;
  filter: Filter;
  tag: string;
  page: number;
  pageSize: number;
};

export function creatorBrowseStateFromSearch<Filter extends string>(
  search: string,
  fallback: CreatorBrowseState<Filter>,
  filters: readonly Filter[],
  pageSizes: readonly number[],
) {
  const params = new URLSearchParams(search);
  const filter = params.get("filter") as Filter | null;
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));
  return {
    query: params.get("q") ?? fallback.query,
    filter: filter && filters.includes(filter) ? filter : fallback.filter,
    tag: params.get("tag") ?? fallback.tag,
    page: Number.isInteger(page) && page > 0 ? page : fallback.page,
    pageSize: pageSizes.includes(pageSize) ? pageSize : fallback.pageSize,
  };
}

export function creatorBrowseSearch<Filter extends string>(state: CreatorBrowseState<Filter>) {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.filter !== "all") params.set("filter", state.filter);
  if (state.tag) params.set("tag", state.tag);
  if (state.page > 1) params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  const value = params.toString();
  return value ? `?${value}` : "";
}

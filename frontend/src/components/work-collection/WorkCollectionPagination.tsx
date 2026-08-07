import { CollectionPagination, type CollectionPaginationProps } from "@/components/collection/CollectionPagination";

export function WorkCollectionPagination(props: Omit<CollectionPaginationProps, "itemLabel" | "ariaLabel">) {
  const currentPage = Math.min(Math.max(1, props.totalPages), Math.max(1, props.page));
  return (
    <CollectionPagination
      {...props}
      itemLabel="works"
      ariaLabel="Work pages"
      summary={`Page ${currentPage} / ${Math.max(1, props.totalPages)} · ${props.totalItems} works`}
    />
  );
}

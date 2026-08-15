import { CollectionPagination, type CollectionPaginationProps } from "@/components/collection/CollectionPagination";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

export function WorkCollectionPagination(props: Omit<CollectionPaginationProps, "itemLabel" | "ariaLabel">) {
  const { t } = useTranslation("translation", { i18n });
  const currentPage = Math.min(Math.max(1, props.totalPages), Math.max(1, props.page));
  return (
    <CollectionPagination
      {...props}
      itemLabel={t("collection.works")}
      ariaLabel={t("collection.pages")}
      summary={t("collection.pageOf", {
        page: currentPage,
        totalPages: Math.max(1, props.totalPages),
        totalItems: props.totalItems,
        itemLabel: t("collection.works"),
      })}
    />
  );
}

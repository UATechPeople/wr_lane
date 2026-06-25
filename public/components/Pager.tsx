export function Pager({
  page,
  pages,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
}) {
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);
  const btn =
    "rounded-lg border border-neutral-300 px-2.5 py-1.5 text-neutral-600 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div className="mt-4 flex items-center justify-between text-sm">
      <span className="tabular-nums text-neutral-500">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button disabled={page === 0} onClick={() => onPage(page - 1)} className={btn}>
          ‹
        </button>
        <button disabled={page + 1 >= pages} onClick={() => onPage(page + 1)} className={btn}>
          ›
        </button>
      </div>
    </div>
  );
}

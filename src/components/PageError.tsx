type PageErrorProps = {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  title?: string;
  compact?: boolean;
};

export function PageError({
  message,
  onRetry,
  retryLabel = "Try again",
  title,
  compact = false,
}: PageErrorProps) {
  if (compact) {
    return (
      <div role="alert">
        <p className="text-sm text-red-300">{message}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black"
          >
            {retryLabel}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div role="alert" className="max-w-md rounded-lg border border-white/10 bg-white/[0.04] p-6">
      {title ? <h1 className="text-xl font-semibold">{title}</h1> : null}
      <p className={title ? "mt-2 text-sm leading-6 text-white/65" : "text-sm leading-6 text-white/65"}>
        {message}
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:scale-[1.02] hover:bg-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

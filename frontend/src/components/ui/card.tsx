import { type ReactNode } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`bg-card/80 border border-border rounded-xl ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  icon,
  title,
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={`flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-border ${className}`}
    >
      {icon}
      <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
    </header>
  );
}

export function CardBody({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`px-6 py-5 ${className}`}>{children}</div>;
}

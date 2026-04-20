import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";

type Option = { value: string; label: string };

type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  options: Option[];
};

export function Select({ options, className = "", ...rest }: Props) {
  return (
    <div className="relative">
      <select
        {...rest}
        className={`w-full appearance-none bg-input/70 border border-border rounded-md px-3 py-2.5 pr-9 text-sm text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 transition-colors ${className}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-card">
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 opacity-50" />
    </div>
  );
}

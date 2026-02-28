import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from "react";
import Link from "next/link";

const base =
  "inline-flex items-center justify-center gap-2 rounded-2xl border text-sm font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-50";

const variantClass = {
  primary: "border-slate-900 bg-slate-900 text-white hover:bg-slate-800",
  secondary: "border-slate-200 bg-white text-slate-900 hover:bg-slate-50",
  subtle: "border-transparent bg-slate-100 text-slate-700 hover:bg-slate-200",
  destructive: "border-red-200 bg-red-50 text-red-700 hover:bg-red-100",
  ghost: "border-transparent bg-transparent text-slate-700 hover:bg-slate-100",
} as const;

const sizeClass = {
  sm: "h-9 px-3",
  md: "h-11 px-4",
  lg: "h-12 px-5",
} as const;

type SharedProps = {
  children: ReactNode;
  variant?: keyof typeof variantClass;
  size?: keyof typeof sizeClass;
  className?: string;
};

type ButtonProps = SharedProps & ButtonHTMLAttributes<HTMLButtonElement>;
type LinkProps = SharedProps & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

function classes(variant: keyof typeof variantClass, size: keyof typeof sizeClass, className?: string) {
  return [base, variantClass[variant], sizeClass[size], className].filter(Boolean).join(" ");
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <button className={classes(variant, size, className)} {...props}>
      {children}
    </button>
  );
}

export function ButtonLink({
  children,
  variant = "primary",
  size = "md",
  className,
  href,
  ...props
}: LinkProps) {
  return (
    <Link href={href} className={classes(variant, size, className)} {...props}>
      {children}
    </Link>
  );
}

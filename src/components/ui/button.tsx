import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-[background,color,border-color,box-shadow,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 cursor-default [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-fg text-white hover:bg-[#3a3833] shadow-[0_1px_2px_rgb(0_0_0/0.12)] rounded-full",
        secondary: "bg-surface text-fg border border-line-2 hover:bg-surface-2 hover:border-dim",
        ghost: "text-fg-2 hover:text-fg hover:bg-surface-3",
        outline: "border border-line-2 text-fg-2 hover:text-fg hover:border-dim hover:bg-surface-2",
        danger: "bg-red/12 text-red border border-red/35 hover:bg-red/20",
        success: "bg-green/12 text-green border border-green/35 hover:bg-green/20",
        warn: "bg-amber/12 text-amber border border-amber/40 hover:bg-amber/20",
      },
      size: {
        xs: "h-6 px-2 text-[11px]",
        sm: "h-7 px-2.5 text-xs",
        md: "h-8 px-3 text-[13px]",
        icon: "size-7",
        "icon-sm": "size-6",
      },
    },
    defaultVariants: { variant: "secondary", size: "sm" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type, ...props }, ref) => (
  <button ref={ref} type={type ?? "button"} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = "Button";

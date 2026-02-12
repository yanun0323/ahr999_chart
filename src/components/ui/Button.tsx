import type { JSX } from "solid-js";

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost";
}

export const Button = (props: ButtonProps) => {
  const variant = () => props.variant ?? "primary";

  return (
    <button
      {...props}
      class={`ui-button ${variant()} ${props.class ?? ""}`}
      type={props.type ?? "button"}
    >
      {props.children}
    </button>
  );
};

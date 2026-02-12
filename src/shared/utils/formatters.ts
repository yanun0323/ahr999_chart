const priceFormatter = new Intl.NumberFormat("zh-TW", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const ratioFormatter = new Intl.NumberFormat("zh-TW", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3
});

export const formatPrice = (value: number): string => priceFormatter.format(value);
export const formatRatio = (value: number): string => ratioFormatter.format(value);

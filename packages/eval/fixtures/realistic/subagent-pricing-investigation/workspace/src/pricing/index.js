const { applyPercentDiscount } = require('./discounts');

function quoteTotal(items, discountPercent) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return applyPercentDiscount(subtotal, discountPercent);
}

module.exports = { quoteTotal };

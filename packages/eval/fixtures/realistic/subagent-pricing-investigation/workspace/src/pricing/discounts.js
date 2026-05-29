function applyPercentDiscount(amount, percent) {
  return amount - amount * (percent / 10);
}

module.exports = { applyPercentDiscount };

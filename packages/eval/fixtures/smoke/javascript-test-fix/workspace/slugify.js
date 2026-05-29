module.exports = function slugify(input) {
  return input.replace(/\s+/g, "_");
};

function serializeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email || null,
    isActive: Boolean(user.enabled),
  };
}

module.exports = { serializeUser };

const METHODS = ['get', 'post', 'patch', 'put', 'delete'];

// Express 4 does not catch rejected promises from async route handlers --
// an unhandled rejection there crashes the whole process, taking the server
// down for every connected user. Wrap each handler so a thrown/rejected
// error reaches Express's error middleware as a clean response instead.
function patchRouter(router) {
  METHODS.forEach((method) => {
    const original = router[method].bind(router);
    router[method] = (path, handler) => original(path, (req, res, next) => {
      Promise.resolve(handler(req, res, next)).catch(next);
    });
  });
  return router;
}

module.exports = patchRouter;

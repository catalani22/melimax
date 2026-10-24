export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('[error]', req.method, req.originalUrl, err.message);
  }

  res.status(status).json({
    error: err.friendlyMessage || err.message || 'Erro interno do servidor',
    ...(err.code ? { code: err.code } : {}),
    ...(err.code === 'ML_REAUTH' ? { needs_reauth: true } : {}),
    ...(err.details ? { details: err.details } : {}),
    ...(process.env.NODE_ENV === 'development' && err.stack ? { stack: err.stack } : {}),
  });
}

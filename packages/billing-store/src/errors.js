class BillingError extends Error {
  constructor(message, { code, retryable, httpStatus } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
  }
}

export class TenantNotFoundError extends BillingError {
  constructor(tenantId) {
    super(`tenant_not_found:${tenantId}`, {
      code: "ERR_TENANT_NOT_FOUND",
      retryable: false,
      httpStatus: 404
    });
  }
}

export class BillingCurrencyUnsupportedError extends BillingError {
  constructor(currency) {
    super(`billing_currency_unsupported:${currency}`, {
      code: "ERR_BILLING_CURRENCY_UNSUPPORTED",
      retryable: false,
      httpStatus: 400
    });
  }
}

export class QuotaExceededError extends BillingError {
  constructor(windowKind = null) {
    super(windowKind ? `quota_exceeded:${windowKind}` : "quota_exceeded", {
      code: "ERR_QUOTA_EXCEEDED",
      retryable: true,
      httpStatus: 429
    });
  }
}

export class BillingInternalError extends BillingError {
  constructor(reason = "billing_internal") {
    super(reason, {
      code: "ERR_BILLING_INTERNAL",
      retryable: true,
      httpStatus: 500
    });
    this.reason = reason;
  }
}

export class RechargeDuplicateKeyError extends BillingError {
  constructor(rechargeId) {
    super(`recharge_duplicate_key:${rechargeId}`, {
      code: "ERR_RECHARGE_DUPLICATE_KEY",
      retryable: false,
      httpStatus: 409
    });
  }
}

export { BillingError };

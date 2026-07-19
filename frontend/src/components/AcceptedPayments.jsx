import { PAYMENT_LOGOS } from '../constants/paymentLogos';

export default function AcceptedPayments() {
  return (
    <section className="accepted-payments-strip" aria-label="Accepted Payment Gateways">
      <div className="accepted-payments-strip-inner">
        <h2 className="accepted-payments-title">Accepted Payment Gateways</h2>
        <ul className="accepted-payments-logos">
          {PAYMENT_LOGOS.map(method => (
            <li key={method.id} className="accepted-payments-logo-item">
              <div className="accepted-payments-logo-wrap">
                <img
                  src={method.logoSrc}
                  alt={method.name}
                  className="accepted-payments-logo"
                  loading="lazy"
                  decoding="async"
                />
                {method.showName && (
                  <span className="accepted-payments-logo-name">{method.name}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

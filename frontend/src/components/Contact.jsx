import { useState } from 'react';
import SocialLinks from './SocialLinks';
import { CONTACT_EMAIL } from '../config/appUrls';

export default function Contact({ onNavigateHome }) {
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    subject: '',
    message: ''
  });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const updateField = field => event => {
    setForm(prev => ({ ...prev, [field]: event.target.value }));
  };

  const handleSubmit = event => {
    event.preventDefault();
    setError('');

    if (!form.name.trim() || !form.email.trim() || !form.subject.trim() || !form.message.trim()) {
      setError('Please fill in all required fields.');
      return;
    }

    const body = encodeURIComponent(
      `Name: ${form.name}\nEmail: ${form.email}\nPhone: ${form.phone || 'Not provided'}\n\n${form.message}`
    );
    const subject = encodeURIComponent(form.subject);
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
    setSent(true);
  };

  return (
    <div className="contact-page">
      <nav className="page-breadcrumb" aria-label="Breadcrumb">
        <button type="button" className="breadcrumb-link" onClick={onNavigateHome}>
          Home
        </button>
        <span className="breadcrumb-separator">/</span>
        <span className="breadcrumb-current">Contact</span>
      </nav>

      <div className="contact-hero">
        <p className="contact-eyebrow">Contact</p>
        <h1>Reach Out to Our AI Team</h1>
        <p className="contact-lead">
          Tell us about your trading goals and we will connect you with the right AI plan.
        </p>
      </div>

      <div className="contact-layout">
        <div className="contact-form-card">
          <form className="contact-form" onSubmit={handleSubmit} noValidate>
            <input
              type="text"
              name="website"
              className="contact-honeypot"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
            />

            <div className="contact-form-grid">
              <label className="contact-field">
                <span>Name</span>
                <input
                  type="text"
                  name="name"
                  value={form.name}
                  onChange={updateField('name')}
                  placeholder="Your Name"
                  required
                />
              </label>

              <label className="contact-field">
                <span>Email</span>
                <input
                  type="email"
                  name="email"
                  value={form.email}
                  onChange={updateField('email')}
                  placeholder="Your Email"
                  required
                />
              </label>

              <label className="contact-field">
                <span>Phone</span>
                <input
                  type="tel"
                  name="phone"
                  value={form.phone}
                  onChange={updateField('phone')}
                  placeholder="Your Phone"
                />
              </label>

              <label className="contact-field">
                <span>Subject</span>
                <input
                  type="text"
                  name="subject"
                  value={form.subject}
                  onChange={updateField('subject')}
                  placeholder="Subject"
                  required
                />
              </label>
            </div>

            <label className="contact-field contact-field-full">
              <span>Message</span>
              <textarea
                name="message"
                rows={5}
                value={form.message}
                onChange={updateField('message')}
                placeholder="Tell us about your trading goals"
                required
              />
            </label>

            {error && <p className="contact-error">{error}</p>}
            {sent && (
              <p className="contact-success">
                Your email client is opening. Send the message to reach our support team.
              </p>
            )}

            <button type="submit" className="contact-submit">
              Send Message →
            </button>
          </form>
        </div>

        <aside className="contact-sidebar">
          <h2>Contact Details</h2>
          <p className="contact-sidebar-lead">
            Fast support for traders who want to win with our AI Scanner.
          </p>

          <div className="contact-method">
            <span className="contact-method-label">Email</span>
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </div>

          <div className="contact-method">
            <span className="contact-method-label">Phone</span>
            <p>
              <a href="tel:+254745522225">+254 745522225</a>
              {' / '}
              <a href="tel:+254737970108">+254 737970108</a>
            </p>
          </div>

          <div className="contact-method">
            <span className="contact-method-label">Trading Hours</span>
            <p>Active during major forex sessions and customer support hours.</p>
          </div>

          <div className="contact-social">
            <h3>Connect with us</h3>
            <SocialLinks variant="light" />
          </div>
        </aside>
      </div>
    </div>
  );
}

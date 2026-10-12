import Link from "next/link";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";

const handoffSteps = [
  {
    number: "01",
    title: "Create the payment",
    description: "Add the person, amount, and a reference your team will recognize later.",
  },
  {
    number: "02",
    title: "Keep the record clear",
    description: "Follow the payment from its first step with one status your team can understand.",
  },
  {
    number: "03",
    title: "Leave the receive choice to them",
    description: "Your recipient can record whether they prefer USDC or a Nigerian bank payout.",
  },
];

export function MarketingLanding() {
  return (
    <main className="onda-landing">
      <header className="landing-nav-wrap">
        <div className="landing-nav">
          <Brand />
          <nav aria-label="Main navigation" className="landing-nav-links">
            <a href="#how-it-works">How it works</a>
            <Link href="/recipient">Recipient portal</Link>
            <Link className="landing-nav-login" href="/login">Sign in</Link>
            <Button
              className="landing-nav-cta h-10 px-4"
              render={<Link href="/signup" />}
              role="link"
              size="sm"
            >
              Create account <ArrowUpRight aria-hidden="true" size={14} />
            </Button>
          </nav>
        </div>
      </header>

      <section aria-labelledby="landing-title" className="landing-hero">
        <div className="landing-hero-copy">
          <p className="landing-kicker"><span />PAYMENTS TO NIGERIA</p>
          <h1 id="landing-title">
            Pay someone.
            <span>Leave room for choice.</span>
          </h1>
          <p className="landing-intro">
            A clearer way for businesses to pay people in Nigeria—and give each recipient a say in what comes next.
          </p>
          <div className="landing-actions">
            <Button render={<Link href="/signup" />} role="link">
              Pay someone <ArrowRight aria-hidden="true" size={16} />
            </Button>
            <Link className="landing-secondary-link" href="/login">I already have an account</Link>
          </div>
          <div className="landing-caption">
            <span className="landing-caption-rule" />
            <span>One payment. A more considered handoff.</span>
          </div>
        </div>

        <div aria-label="Illustration of a business payment and recipient preferences" className="handoff-visual">
          <div className="handoff-visual-head">
            <span>THE PAYMENT HANDOFF</span>
            <span className="handoff-index">01 — 03</span>
          </div>

          <div className="handoff-source">
            <span className="handoff-node-icon"><ArrowUpRight aria-hidden="true" size={17} /></span>
            <span><small>STARTS WITH</small><strong>Your business</strong></span>
            <span className="handoff-source-note">Create a payment</span>
          </div>

          <div aria-hidden="true" className="handoff-route">
            <span className="handoff-route-line" />
            <span className="handoff-route-dot" />
            <ArrowDownRight className="handoff-route-turn" size={16} />
          </div>

          <div className="handoff-recipient">
            <div className="handoff-recipient-top">
              <span className="handoff-recipient-avatar">R</span>
              <span><small>ARRIVES WITH</small><strong>Your recipient</strong></span>
              <span className="handoff-recipient-country">NG</span>
            </div>
            <div className="handoff-choice-label">THEIR PREFERENCE</div>
            <div className="handoff-choice handoff-choice-selected">
              <span className="handoff-choice-mark">$</span>
              <span><strong>Keep as USDC</strong><small>Receive in a digital dollar</small></span>
              <span className="handoff-choice-radio" />
            </div>
            <div className="handoff-choice">
              <span className="handoff-choice-mark handoff-choice-mark-naira">₦</span>
              <span><strong>Prefer a bank payout</strong><small>Choose a Nigerian bank account</small></span>
              <span className="handoff-choice-radio" />
            </div>
            <div className="handoff-preference-note">Illustrative preferences · no payment shown</div>
          </div>
        </div>
      </section>

      <section aria-labelledby="handoff-title" className="landing-how" id="how-it-works">
        <div className="landing-how-heading">
          <p className="landing-section-label">A PAYMENT, MADE LEGIBLE</p>
          <h2 id="handoff-title">The details stay clear.<br /><span>The choice stays theirs.</span></h2>
          <p>Onda gives your team one calm place to create a payment and follow its progress, while keeping the recipient’s preference in view.</p>
        </div>
        <div className="landing-steps">
          {handoffSteps.map((step, index) => (
            <article className="landing-step" key={step.number}>
              <span className={`landing-step-number${index === 2 ? " landing-step-number-current" : ""}`}>{step.number}</span>
              <div className="landing-step-copy">
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </div>
              <span aria-hidden="true" className="landing-step-arrow"><ArrowUpRight size={17} /></span>
            </article>
          ))}
          <p className="landing-capability-note">Bank conversion and payout availability depend on enabled services.</p>
        </div>
      </section>

      <footer className="landing-footer-premium">
        <Brand compact />
        <span>Business payments to Nigeria</span>
        <div><Link href="/recipient">Recipient portal</Link><Link href="/login">Sign in</Link></div>
      </footer>
    </main>
  );
}

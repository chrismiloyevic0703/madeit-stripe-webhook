const express = require('express');
const Stripe = require('stripe');
const axios = require('axios');

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16'
});

// Map Stripe product IDs to human-readable plan names.
// These are your product IDs from Stripe.
const PLAN_MAP = {
  prod_QitoWsRWrfLg0e: 'Starter',
  prod_Qitrfh0Q6QSIoC: 'Business',
  prod_TWPbyx7qGRLd6J: 'Growth'
};

// Stripe sends signed webhooks; we must verify signature using raw body.
router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;

    if (process.env.DISABLE_STRIPE_SIGNATURE === '1') {
      // In test mode, skip Stripe signature verification and trust the raw payload.
      try {
        event = JSON.parse(req.body.toString());
      } catch (err) {
        console.error('Failed to parse webhook body:', err.message);
        return res.status(400).send('Invalid JSON');
      }
    } else {
      // In live mode, strictly verify the Stripe signature.
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error('Stripe webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }
    }

    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const subscription = event.data.object;

          const firstItem = subscription.items.data[0];
          const productId = firstItem?.price?.product;
          const planName = PLAN_MAP[productId] || 'Unknown';

          const customerId = subscription.customer;

          try {
            const customer = await stripe.customers.retrieve(customerId);
            const email = customer.email;

            if (!email) {
              console.warn('No email found for Stripe customer', customerId);
              break;
            }

            try {
              await updateKlaviyoProfile({
                email,
                membershipPlan: planName,
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscription.id
              });
            } catch (err) {
              console.error('Failed to update Klaviyo profile:', err.message || err);
              // Do not fail the webhook; Stripe just needs a 2xx.
            }
          } catch (err) {
            console.error('Failed to retrieve Stripe customer:', err.message || err);
          }

          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          const customerId = subscription.customer;

          try {
            const customer = await stripe.customers.retrieve(customerId);
            const email = customer.email;

            if (!email) {
              console.warn('No email found for Stripe customer', customerId);
              break;
            }

            try {
              await updateKlaviyoProfile({
                email,
                membershipPlan: 'None',
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscription.id
              });
            } catch (err) {
              console.error('Failed to update Klaviyo profile (delete):', err.message || err);
              // Do not fail the webhook.
            }
          } catch (err) {
            console.error('Failed to retrieve Stripe customer (delete):', err.message || err);
          }

          break;
        }

        default:
          break;
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Error handling Stripe webhook:', error);
      res.status(500).send('Internal Server Error');
    }
  }
);

async function updateKlaviyoProfile({
  email,
  membershipPlan,
  stripeCustomerId,
  stripeSubscriptionId
}) {
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

  if (!KLAVIYO_API_KEY) {
    console.error('KLAVIYO_API_KEY is not set');
    return;
  }

  try {
    const response = await axios.post(
      'https://a.klaviyo.com/api/profile-import',
      {
        data: {
          type: 'profile',
          attributes: {
            email,
            properties: {
              membership_plan: membershipPlan,
              stripe_customer_id: stripeCustomerId,
              stripe_subscription_id: stripeSubscriptionId
            }
          }
        }
      },
      {
        headers: {
          Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      }
    );

    console.log(
      'Klaviyo profile import response:',
      response.status,
      response.statusText
    );
  } catch (err) {
    console.error(
      'Klaviyo profile import failed:',
      err.response?.status,
      err.response?.data || err.message
    );
  }
}

module.exports = router;


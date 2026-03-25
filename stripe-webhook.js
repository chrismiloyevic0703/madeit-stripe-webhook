const express = require('express');
const Stripe = require('stripe');
const axios = require('axios');

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16'
});

// Stripe product ID → plan name (must match Klaviyo segment values).
// Add test product IDs (prod_...) here when testing in Stripe test mode.
const PLAN_MAP = {
  prod_U4tCikdA2Kr75c: 'Maker',
  prod_TnLttAZD9UmMxf: 'Hobby',
  prod_Qitrfh0Q6QSIoC: 'Business',
  prod_TWPbyx7qGRLd6J: 'The Growth Circle 🚀'
};

/** Stripe subscription item → product id (handles price- or plan-based items). */
function productIdFromSubscriptionItem(item) {
  if (!item) return null;
  return item.price?.product ?? item.plan?.product ?? null;
}

/** Previous product id from webhook previous_attributes (plan change). */
function previousProductIdFromEvent(previousAttributes) {
  if (!previousAttributes) return null;
  const items = previousAttributes.items;
  if (items?.data?.length) {
    return productIdFromSubscriptionItem(items.data[0]);
  }
  if (previousAttributes.plan?.product) {
    return previousAttributes.plan.product;
  }
  return null;
}

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
        case 'customer.subscription.created': {
          const subscription = event.data.object;
          const firstItem = subscription.items.data[0];
          const productId = productIdFromSubscriptionItem(firstItem);
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
                previousMembershipPlan: 'None',
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscription.id
              });
            } catch (err) {
              console.error('Failed to update Klaviyo profile:', err.message || err);
            }
          } catch (err) {
            console.error('Failed to retrieve Stripe customer:', err.message || err);
          }

          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object;
          const previousAttributes = event.data.previous_attributes;

          const firstItem = subscription.items.data[0];
          const productId = productIdFromSubscriptionItem(firstItem);
          const planName = PLAN_MAP[productId] || 'Unknown';

          const prevProductId = previousProductIdFromEvent(previousAttributes);
          const previousPlanName = prevProductId
            ? PLAN_MAP[prevProductId] || 'Unknown'
            : null;

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
                previousMembershipPlan: previousPlanName,
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscription.id
              });
            } catch (err) {
              console.error('Failed to update Klaviyo profile:', err.message || err);
            }
          } catch (err) {
            console.error('Failed to retrieve Stripe customer:', err.message || err);
          }

          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          const customerId = subscription.customer;
          const firstItem = subscription.items.data[0];
          const prevProductId = productIdFromSubscriptionItem(firstItem);
          const previousPlanName = prevProductId
            ? PLAN_MAP[prevProductId] || 'Unknown'
            : 'None';

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
                previousMembershipPlan: previousPlanName,
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscription.id
              });
            } catch (err) {
              console.error('Failed to update Klaviyo profile (delete):', err.message || err);
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
  previousMembershipPlan,
  stripeCustomerId,
  stripeSubscriptionId
}) {
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

  if (!KLAVIYO_API_KEY) {
    console.error('KLAVIYO_API_KEY is not set');
    return;
  }

  const properties = {
    membership_plan: membershipPlan,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId
  };

  if (previousMembershipPlan != null) {
    properties.previous_membership_plan = previousMembershipPlan;
  }

  try {
    const response = await axios.post(
      'https://a.klaviyo.com/api/profile-import',
      {
        data: {
          type: 'profile',
          attributes: {
            email,
            properties
          }
        }
      },
      {
        headers: {
          Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          revision: '2024-02-15'
        }
      }
    );

    console.log(
      'Klaviyo profile import response:',
      response.status,
      response.statusText
    );
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(
      'Klaviyo profile import failed:',
      status,
      body ? JSON.stringify(body) : err.message
    );
  }
}

module.exports = router;


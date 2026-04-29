const express = require('express');
const Stripe = require('stripe');
const axios = require('axios');

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16'
});

// Stripe product ID → plan name (must match Klaviyo segment values).
// Test and live Dashboards use different prod_ IDs; list both so webhooks work
// with sk_test_... + test webhook secret or sk_live_... + live secret.
const PLAN_MAP = {
  prod_U4tCikdA2Kr75c: 'Maker',
  prod_TWPbyx7qGRLd6J: 'The Growth Circle 🚀',
  prod_QitoWsRWrfLg0e: 'Starter',
  prod_QitpakMNqIa4rs: 'Artisan',

  prod_MfxwKxisQiI5pQ: 'Hobby',
  prod_RDrvOrlcGKv17S: 'Business',

  prod_TnLttAZD9UmMxf: 'Hobby',
  prod_Qitrfh0Q6QSIoC: 'Business'
};

/** Stripe may send price.product as an ID string or as an expanded object. */
function productIdFromPrice(price) {
  if (!price || typeof price === 'string') return null;
  const p = price.product;
  if (typeof p === 'string') return p;
  if (p && typeof p === 'object' && typeof p.id === 'string') return p.id;
  return null;
}

/** Reads prod_ id from subscription.items (or previous_attributes.items). */
function productIdFromItems(items) {
  const firstItem = items?.data?.[0];
  return productIdFromPrice(firstItem?.price);
}

function productIdFromSubscription(subscription) {
  return productIdFromItems(subscription.items);
}

/**
 * On subscription.updated, Stripe includes previous_attributes with old values
 * for fields that changed. When the plan changes, items reflects the prior line items.
 */
function productIdFromPreviousAttributes(previousAttributes) {
  if (!previousAttributes?.items) return null;
  return productIdFromItems(previousAttributes.items);
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

          const productId = productIdFromSubscription(subscription);
          const planName = (productId && PLAN_MAP[productId]) || 'Unknown';
          if (!productId) {
            console.warn(
              'Stripe subscription has no price.product on first item; event',
              event.id,
              'subscription',
              subscription.id
            );
          } else if (planName === 'Unknown') {
            console.warn(
              'No PLAN_MAP entry for product',
              productId,
              '— add this prod_ id for correct Klaviyo membership_plan'
            );
          }

          const customerId =
            typeof subscription.customer === 'string'
              ? subscription.customer
              : subscription.customer?.id;

          if (!customerId) {
            console.warn('No Stripe customer id on subscription', subscription.id);
            break;
          }

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
              // Do not fail the webhook; Stripe just needs a 2xx.
            }
          } catch (err) {
            console.error('Failed to retrieve Stripe customer:', err.message || err);
          }

          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object;

          const productId = productIdFromSubscription(subscription);
          const planName = (productId && PLAN_MAP[productId]) || 'Unknown';
          if (!productId) {
            console.warn(
              'Stripe subscription has no price.product on first item; event',
              event.id,
              'subscription',
              subscription.id
            );
          } else if (planName === 'Unknown') {
            console.warn(
              'No PLAN_MAP entry for product',
              productId,
              '— add this prod_ id for correct Klaviyo membership_plan'
            );
          }

          const prevProductId = productIdFromPreviousAttributes(
            event.data.previous_attributes
          );
          let previousMembershipPlan;
          if (prevProductId) {
            previousMembershipPlan = PLAN_MAP[prevProductId] || 'Unknown';
            if (previousMembershipPlan === 'Unknown') {
              console.warn(
                'No PLAN_MAP entry for previous product',
                prevProductId,
                '— add this prod_ id for correct Klaviyo previous_membership_plan'
              );
            }
          }
          // If items did not change, omit previous_membership_plan so Klaviyo keeps the last value.

          const customerId =
            typeof subscription.customer === 'string'
              ? subscription.customer
              : subscription.customer?.id;

          if (!customerId) {
            console.warn('No Stripe customer id on subscription', subscription.id);
            break;
          }

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
                previousMembershipPlan,
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
          const customerId =
            typeof subscription.customer === 'string'
              ? subscription.customer
              : subscription.customer?.id;

          if (!customerId) {
            console.warn('No Stripe customer id on subscription (delete)', subscription.id);
            break;
          }

          try {
            const customer = await stripe.customers.retrieve(customerId);
            const email = customer.email;

            if (!email) {
              console.warn('No email found for Stripe customer', customerId);
              break;
            }

            try {
              const lastProductId = productIdFromSubscription(subscription);
              const previousMembershipPlan = lastProductId
                ? PLAN_MAP[lastProductId] || 'Unknown'
                : 'None';

              await updateKlaviyoProfile({
                email,
                membershipPlan: 'None',
                previousMembershipPlan,
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
  if (previousMembershipPlan !== undefined) {
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
          'Content-Type': 'application/vnd.api+json',
          Accept: 'application/vnd.api+json',
          revision: '2024-02-15'
        }
      }
    );

    console.log('Klaviyo profile import ok:', response.status, {
      email,
      membership_plan: membershipPlan,
      ...(previousMembershipPlan !== undefined && {
        previous_membership_plan: previousMembershipPlan
      })
    });
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
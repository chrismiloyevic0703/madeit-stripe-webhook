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

/**
 * Prefer a subscription line whose product is in PLAN_MAP (membership line),
 * not necessarily items.data[0] (Stripe order can vary).
 */
function primaryMembershipProductId(subscription) {
  const items = subscription?.items?.data;
  if (!items?.length) return null;
  for (const item of items) {
    const pid = productIdFromSubscriptionItem(item);
    if (pid && PLAN_MAP[pid]) return pid;
  }
  return productIdFromSubscriptionItem(items[0]);
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
          const productId = primaryMembershipProductId(subscription);
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

          const productId = primaryMembershipProductId(subscription);
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
          const prevProductId = primaryMembershipProductId(subscription);
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

function klaviyoApiHeaders(apiKey) {
  const revision = process.env.KLAVIYO_API_REVISION || '2025-01-15';
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    'Content-Type': 'application/vnd.api+json',
    Accept: 'application/vnd.api+json',
    revision
  };
}

/** Resolve Klaviyo profile id by email (JSON:API filter). */
async function getKlaviyoProfileIdByEmail(email, headers) {
  try {
    const filter = encodeURIComponent(`equals(email,"${email}")`);
    const { data } = await axios.get(
      `https://a.klaviyo.com/api/profiles/?filter=${filter}`,
      { headers }
    );
    const row = data?.data?.[0];
    return row?.id ?? null;
  } catch (err) {
    console.error(
      'Klaviyo get profile by email failed:',
      err.response?.status,
      err.response?.data ? JSON.stringify(err.response.data) : err.message
    );
    return null;
  }
}

/** Fetch existing profile attributes so PATCH does not wipe other custom properties. */
async function fetchKlaviyoProfileAttributes(profileId, headers) {
  try {
    const { data } = await axios.get(
      `https://a.klaviyo.com/api/profiles/${profileId}/`,
      { headers }
    );
    return data?.data?.attributes ?? {};
  } catch (err) {
    console.error(
      'Klaviyo get profile failed:',
      err.response?.status,
      err.response?.data ? JSON.stringify(err.response.data) : err.message
    );
    return {};
  }
}

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

  const headers = klaviyoApiHeaders(KLAVIYO_API_KEY);

  const properties = {
    membership_plan: membershipPlan,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId
  };

  if (previousMembershipPlan != null) {
    properties.previous_membership_plan = previousMembershipPlan;
  }

  try {
    let profileId = await getKlaviyoProfileIdByEmail(email, headers);

    if (!profileId) {
      const importRes = await axios.post(
        'https://a.klaviyo.com/api/profile-import/',
        {
          data: {
            type: 'profile',
            attributes: {
              email,
              properties
            }
          }
        },
        { headers }
      );
      profileId = importRes.data?.data?.id ?? null;
      console.log(
        'Klaviyo profile-import:',
        importRes.status,
        profileId ? `id=${profileId}` : '(no id in response)'
      );
    }

    if (!profileId) {
      console.error('Klaviyo: could not resolve profile id for', email);
      return;
    }

    const existingAttrs = await fetchKlaviyoProfileAttributes(
      profileId,
      headers
    );
    const mergedProperties = {
      ...(existingAttrs.properties || {}),
      ...properties
    };

    const patchRes = await axios.patch(
      `https://a.klaviyo.com/api/profiles/${profileId}/`,
      {
        data: {
          type: 'profile',
          id: profileId,
          attributes: {
            properties: mergedProperties
          }
        }
      },
      { headers }
    );

    console.log('Klaviyo profile PATCH:', patchRes.status, patchRes.statusText);
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(
      'Klaviyo profile update failed:',
      status,
      body ? JSON.stringify(body) : err.message
    );
  }
}

module.exports = router;


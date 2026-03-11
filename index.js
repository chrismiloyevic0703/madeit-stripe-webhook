require('dotenv').config();

const express = require('express');
const stripeWebhookRouter = require('./stripe-webhook');

const app = express();
const PORT = process.env.PORT || 4000;

// Stripe webhook must use raw body, so do NOT use express.json() on that route.
app.use('/webhooks', stripeWebhookRouter);

// For all other routes you can use JSON body parsing.
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Madiet API running' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});


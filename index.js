require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const externalUrl = process.env.RENDER_EXTERNAL_URL;
const port = externalUrl && process.env.PORT ? parseInt(process.env.PORT) : 10000;
const baseURL = externalUrl || `https://localhost:${port}`;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: true
});

const createTableQuery = `
  CREATE TABLE IF NOT EXISTS tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vatin VARCHAR(20) NOT NULL,
    firstName VARCHAR(100) NOT NULL,
    lastName VARCHAR(100) NOT NULL,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`;

pool.query(createTableQuery)
    .then(() => console.log('Table "tickets" is ready'))
    .catch((error) => console.error('Error creating table:', error));

const checkAuth = async (req, res, next) => {
    const clientId = req.headers['client_id'];
    const clientSecret = req.headers['client_secret'];

    if (!clientId || !clientSecret) {
        return res.status(401).send('Unauthorized: Missing client credentials');
    }

    const tokenEndpoint = `https://${process.env.DOMAIN}/oauth/token`;
    const data = new URLSearchParams({
        audience: `https://${process.env.DOMAIN}/api/v2/`,
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
    });

    try {
        const response = await axios.post(tokenEndpoint, data.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        req.user = response.data;
        next();
    } catch (error) {
        console.error('Authentication error:', error.response ? error.response.data : error.message);
        res.status(401).send('Unauthorized: Invalid client credentials');
    }
};

app.post('/generate-ticket',checkAuth, async (req, res) => {
    const { vatin, firstName, lastName } = req.body;

    if (!vatin || !firstName || !lastName) {
        return res.status(400).json({ error: 'All fields (vatin, firstName, lastName) are required' });
    }

    try {
        const checkQuery = 'SELECT COUNT(*) FROM tickets WHERE vatin = $1';
        const checkResult = await pool.query(checkQuery, [vatin]);
        const ticketCount = parseInt(checkResult.rows[0].count, 10);

        if (ticketCount >= 3) {
            return res.status(400).json({ error: 'Limit of 3 tickets per VATIN reached' });
        }

        const insertQuery = `
        INSERT INTO tickets (vatin, firstName, lastName)
        VALUES ($1, $2, $3)
        RETURNING id
      `;
        const insertResult = await pool.query(insertQuery, [vatin, firstName, lastName]);
        const ticketId = insertResult.rows[0].id;

        const ticketUrl = `${baseURL}/ticket/${ticketId}`;

        const qrCode = await QRCode.toDataURL(ticketUrl);
        res.json({ message: 'Ticket created', ticketUrl, qrCode });
    } catch (error) {
        console.error('Error creating ticket:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/ticket/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const ticketQuery = 'SELECT * FROM tickets WHERE id = $1';
        const result = await pool.query(ticketQuery, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        const ticket = result.rows[0];
        res.json(ticket);
    } catch (error) {
        console.error('Error fetching ticket:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/', async (req, res) => {
    try {
        const countQuery = 'SELECT COUNT(*) FROM tickets';
        const result = await pool.query(countQuery);
        const ticketCount = result.rows[0].count;

        res.send(`
        <html>
          <body>
            <p>Total Tickets Generated: ${ticketCount}</p>
          </body>
        </html>
      `);
    } catch (error) {
        console.error('Error fetching ticket count:', error);
        res.status(500).send('Internal server error');
    }
});

const cors = require('cors');
app.use(cors());

app.listen(port, () => {
    console.log(`App running at ${baseURL}:${port}`);
});

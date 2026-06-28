const express = require('express')
const app = express()
const cors = require('cors');

const Car = require('./cars.js')

const mongoose = require('mongoose');
mongoose.connect('mongodb://db-service:27017/db');

db = mongoose.connection;
db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', async function() {
    console.log("Connected to Mongoose.");

    // data to insert to table
    const carsData = [
        {
            brand: 'Toyota',
            model: 'Camry',
            years: 2020,
            horsepower: 200,
        },
        {
            brand: 'Ford',
            model: 'Mustang',
            years: 2021,
            horsepower: 450,
        },
        {
            brand: 'Honda',
            model: 'Civic',
            years: 2019,
            horsepower: 158,
        },
        {
            brand: 'Chevrolet',
            model: 'Impala',
            years: 2018,
            horsepower: 197,
        },
        {
            brand: 'BMW',
            model: 'X5',
            years: 2022,
            horsepower: 335,
        },
    ];

    try {
        // insert data in car table
        await Car.insertMany(carsData);
    } catch (err) {
        console.error("Error with the insert of the data :", err);
    }
});

app.use(cors());
app.options('*', cors());            

app.get('/cars', async (req, res) => {
    try {
        const cars = await Car.find();
        res.json(cars);
    } catch (err) {
        console.error('Error when fetching the data :', err);
        res.status(500).json({ error: 'Error when fetching the data.' });
    }
});

app.listen(3070, () => {
    console.log('API - Ready');
}) 
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const carSchema = new Schema({
    brand:  String,
    model: String,
    years:   Number,
    horsepower: Number
});

const Car = mongoose.model('car', carSchema)

module.exports = Car
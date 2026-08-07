-- Create the new user with a password
CREATE USER yenllet_admin WITH PASSWORD 'Prince08';

-- Now create your project database
CREATE DATABASE "setupDB";

-- Give your new user full access to the new database
GRANT ALL PRIVILEGES ON DATABASE "setupDB" TO yenllet_admin;
